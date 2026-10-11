/**
 * The model-facing `read_image` tool commits a PNG/JPEG/WebP/GIF file. A path
 * without a file extension is identified from its file signature, while the
 * attachment service's full decode stays authoritative. The mounted `ctx.fs`
 * backend owns path resolution and read access; names only declare media type.
 *
 * The route gate is deliberately stricter than the host upload preflight. An
 * image-reading tool is useful only when the exact calling route can inspect
 * its result, so unknown capability refuses instead of relying on an adapter
 * failure after filesystem and attachment work.
 *
 * S-45 M3 second branch: when the calling main model does not declare `image`
 * input, the gate consults the deployment `vision` model slot
 * (`modelSlots.resolve('vision')`). A resolved slot routes the image to the
 * visual-assist model and injects a source-tagged TEXT description block
 * instead of the image bytes, so the text-only main model still learns the
 * picture's content. The privacy gate `privacy.localFirstVision` (default
 * true) refuses this outbound vision digestion: the tool-fs layer cannot
 * inspect a provider's endpoint, so every vision slot route is conservatively
 * treated as an external channel.
 * @module @deepseek-ai/dsh-tool-fs/src/read-image
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { ContentBlock, FinishReason, Message } from '@deepseek-ai/dsh-llm'
import { MODEL_SLOT_VISION } from '@deepseek-ai/dsh-model-slots'
import type { ResolvedModelSlot } from '@deepseek-ai/dsh-model-slots'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveRegularReadTarget } from './read-target.ts'

/** Extensions `read_image` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Output-token cap for the vision-slot digestion call. */
const VISION_DESCRIPTION_MAX_TOKENS = 300

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/**
 * Identify the media type declared by a supported image file signature.
 * @param data - file bytes read through the current filesystem backend.
 * @returns the detected supported media type, or undefined for other bytes.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

/** The structured outcome declared by the `read_image` output schema. */
export interface ImageReadValue {
  /** Canonical absolute path in the filesystem provider's execution world. */
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    /** Orientation-applied file dimensions before normalization; present only when storage reduced it. */
    originalDimensions?: {
      width: number
      height: number
    }
  }
}

/**
 * The vision-assisted outcome: a text description of the image plus the exact
 * model-slot origin that produced it, instead of image bytes.
 */
export interface VisionImageReadValue {
  path: string
  /** Plain-text visual-assist description of the image content. */
  description: string
  /** Origin marker naming the slot/provider/model/source tier that produced the description. */
  origin: string
}

/**
 * The value shape the `read_image` output schema declares: `path` plus either
 * an `image` block (native route) or the `description`/`origin` pair
 * (vision-assisted route). Exactly one branch is ever populated.
 */
export interface ImageReadOutputValue {
  path: string
  image?: ImageReadValue['image']
  description?: string
  origin?: string
}

/**
 * Privacy policy governing the vision-assisted digestion branch.
 * `localFirstVision` (default true) refuses every outbound vision call: the
 * tool-fs layer cannot inspect a provider endpoint, so each vision slot route
 * is conservatively treated as an external channel.
 */
export interface ReadImageVisionPrivacy {
  readonly localFirstVision: boolean
}

/** Registration options for the `read_image` tool. */
export interface ReadImageToolOptions {
  readonly privacy?: Readonly<ReadImageVisionPrivacy>
}

const DEFAULT_VISION_PRIVACY: Readonly<ReadImageVisionPrivacy> = Object.freeze({ localFirstVision: true })

/**
 * Map a model-supplied path to its declared image media type by extension.
 * @param filePath - the raw `file_path` argument (not yet resolved).
 * @returns the declared media type, or undefined when the path does not claim an image.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * One route-gate verdict for a `read_image` call: either the exact calling
 * route may receive the image, or the `vision` model slot must digest it into
 * text first. A throw here is a refusal with a model-visible message.
 */
export type ImageRouteDecision =
  | { readonly kind: 'native' }
  | { readonly kind: 'vision'; readonly slot: ResolvedModelSlot }

/**
 * Enforce the strict image-capability gate for the calling route. Resolves the
 * session's latest routed provider/model (request header config, then agent
 * options) and requires the exact resolved route to declare `image` input.
 * When the route is text-only, the gate consults the deployment `vision`
 * model slot: a resolved slot under a permitted privacy posture routes the
 * read to visual-assisted digestion (a source-tagged text description);
 * an unresolvable slot, or a slot refused by `privacy.localFirstVision`,
 * throws the same text-only refusal as before.
 * @param ctx - the plugin context used to resolve the optional `llm`/`modelSlots` services.
 * @param exec - the tool-execution context supplying the calling agent.
 * @param requestedPath - the raw, not-yet-resolved path rendered in refusal messages.
 * @param privacy - the vision privacy posture; defaults to the conservative local-first policy.
 * @returns the routing decision: `native` when the resolved model declares image input, otherwise the vision-slot digestion route.
 */
export async function assertImageCapableRoute(
  ctx: Context,
  exec: ToolExecution,
  requestedPath: string,
  privacy: Readonly<ReadImageVisionPrivacy> = DEFAULT_VISION_PRIVACY,
): Promise<ImageRouteDecision> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    return visionRouteDecision(ctx, exec, model, requestedPath, privacy)
  }
  return { kind: 'native' }
}

/** The text-only refusal kept byte-identical when no vision route is usable. */
function textOnlyRefusal(requestedPath: string, model: string): Error {
  return new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
}

/**
 * The S-45 M3 second branch: resolve the `vision` model slot for a text-only
 * main route and return the digestion verdict, or throw the unchanged refusal.
 * The main route is deliberately NOT offered as the last resolution tier: a
 * text-only main model cannot digest images, so only an explicit `vision` slot
 * statement or the deployment default counts as a usable vision route.
 * @param ctx - the plugin context exposing the optional `modelSlots` service.
 * @param exec - the tool-execution context supplying the calling agent.
 * @param mainModel - the text-only main route model.
 * @param requestedPath - the raw, not-yet-resolved path rendered in refusal messages.
 * @param privacy - the vision privacy posture.
 * @returns the resolved vision slot, or null-refusal via throw.
 */
function visionRouteDecision(
  ctx: Context,
  exec: ToolExecution,
  mainModel: string,
  requestedPath: string,
  privacy: Readonly<ReadImageVisionPrivacy>,
): ImageRouteDecision {
  const slots = ctx.get('modelSlots')
  const resolution = slots?.resolve(MODEL_SLOT_VISION, {
    ...exec.agent?.session === undefined ? {} : { session: exec.agent.session },
  })
  if (resolution === null || resolution === undefined) throw textOnlyRefusal(requestedPath, mainModel)
  if (privacy.localFirstVision) {
    ctx.logger.warn(
      `read_image: vision slot "${resolution.slot}" resolved to ${resolution.provider}/${resolution.model} `
      + `but privacy.localFirstVision is active; refusing outbound vision digestion for "${requestedPath}"`,
    )
    throw new Error(
      `cannot read "${requestedPath}" as an image: model "${mainModel}" does not declare image input `
      + `and privacy.localFirstVision is active, so the vision slot "${resolution.slot}" may not receive the image bytes`,
    )
  }
  return { kind: 'vision', slot: resolution }
}

/** Refuse a media type outside the deployment's accepted set, naming the offending path. */
function assertDeploymentAccepts(attachments: AttachmentStore, mediaType: ImageMediaType, displayPath: string): void {
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot read "${displayPath}": ${mediaType} images are not accepted by this deployment`)
  }
}

/**
 * Re-brand a structured image outcome into the durable attachment reference an
 * `ImageBlock` carries.
 * @param image - the image metadata from the output schema.
 * @returns the branded attachment reference.
 */
export function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.originalDimensions === undefined ? {} : {
      originalDimensions: { ...image.originalDimensions },
    },
  }
}

/**
 * Format an image read as the model-facing envelope beside its image block.
 * A downscaled read names the on-disk dimensions and the multiplier that maps
 * coordinates measured on the attached image back onto the original file.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param image - the image metadata to summarize.
 * @returns the model-facing envelope; the image itself rides the adjacent image block.
 */
export function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string {
  let scaled = ''
  if (image.originalDimensions !== undefined) {
    // Integer rounding can give the two axes slightly different ratios, so the
    // advice names one multiplier only when both round to the same value.
    const x = (image.originalDimensions.width / image.width).toFixed(2)
    const y = (image.originalDimensions.height / image.height).toFixed(2)
    const advice = x === y
      ? `multiply coordinates by ${x}`
      : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}

/**
 * Format the vision-assisted read result as a text block with origin.
 * The main model receives this description instead of image bytes.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param description - the visual-assist model's description text.
 * @param origin - the origin marker naming slot/provider/model/source tier.
 * @returns the model-facing text envelope.
 */
export function formatVisionReadOutput(displayPath: string, description: string, origin: string): string {
  return `<path>${displayPath}</path>
<type>image-description</type>
<content>
<description>${description}</description>
</content>
<origin>
${origin}
</origin>`
}

/**
 * Build the origin marker string from one resolved vision slot.
 * @param slot - the resolved model slot.
 * @returns a multi-line origin block the model may inspect.
 */
function formatVisionOrigin(slot: ResolvedModelSlot): string {
  return `<slot>${slot.slot}</slot>
<provider>${slot.provider}</provider>
<model>${slot.model}</model>
<source>${slot.source}</source>`
}

/**
 * Project one structured image read into its model-facing envelope and image.
 * @param value - the image-read outcome.
 * @returns the two content blocks used by native and nested dispatches.
 */
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': return new Error('read_image: vision slot description reached max-output-tokens')
    case 'tool-calls': return new Error('read_image: vision slot model unexpectedly requested a tool')
    default: return new Error(`read_image: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Digest one committed image through the deployment `vision` model slot and
 * return the plain-text description.
 * @param ctx - the plugin context exposing the `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 * @param slot - the resolved vision slot route.
 * @param ref - the locally committed image attachment ref.
 * @param mediaType - the image media type for the prompt.
 * @returns the plain-text description produced by the vision model.
 */
async function describeImageWithVision(
  ctx: Context,
  exec: ToolExecution,
  slot: ResolvedModelSlot,
  ref: ImageAttachmentRef,
  mediaType: ImageMediaType,
): Promise<string> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('cannot describe an image through the vision slot: no llm service is mounted')
  exec.signal.throwIfAborted()
  const messages: Message[] = [createUserMessage({
    content: [
      { type: 'text', text: `Describe the content of this ${mediaType} image in one sentence, plain text only.` },
      { type: 'image', attachment: ref },
    ],
    // zDSH (SYNC-P2, official B18 adaptation): the shared `kind: 'plugin'` source was
    // removed in 0.1.7. This auxiliary prompt is a one-shot internal call that is
    // never durable, so it rides the base user kind; the vision-slot attribution
    // the main session sees is carried by the origin-tagged description output.
    source: { kind: 'user' },
  })]
  const options = deepFreeze({
    provider: slot.provider,
    model: slot.model,
    messages,
    maxTokens: VISION_DESCRIPTION_MAX_TOKENS,
    signal: exec.signal,
  })
  exec.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) {
    exec.signal.throwIfAborted()
    assembler.push(chunk)
  }
  exec.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  const text = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
  if (text.length === 0) throw new Error('read_image: the vision slot produced no description text')
  return text
}

/**
 * Render one successful `read_image` result into model-facing content blocks.
 * @param value - the result value, either native or vision-assisted.
 * @returns the content blocks; a native result carries an image block, a vision
 *   result carries only text.
 */
function renderReadImageResult(value: ImageReadOutputValue): ContentBlock[] {
  if (value.description !== undefined && value.origin !== undefined) {
    return [{ type: 'text', text: formatVisionReadOutput(value.path, value.description, value.origin) }]
  }
  if (value.image !== undefined) {
    return imageReadContent({ path: value.path, image: value.image })
  }
  // The tool body always produces one complete shape, so this is defensive.
  throw new Error('read_image: result must carry either an image block or a description block with origin')
}

/**
 * Register the `read_image` tool into the given context. The composing plugin
 * owns the attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution still re-checks `ctx.get('attachments')` for
 * direct callers and gates on the calling route's declared image input, with
 * the `vision` model slot as the S-45 M3 digestion fallback for text-only
 * routes.
 * @param ctx - the registration scope; execution uses its `fs` service plus
 *   the optional `attachments`/`llm`/`modelSlots` services.
 * @param options - registration options; the default privacy posture refuses
 *   every outbound vision digestion (`privacy.localFirstVision: true`).
 */
export function applyReadImageTool(
  ctx: Context,
  options: Readonly<ReadImageToolOptions> = {},
): void {
  const privacy = options.privacy ?? DEFAULT_VISION_PRIVACY
  ctx.tools.register(defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. '
      + 'Large images are downscaled automatically; do not install image libraries or create thumbnails to inspect an image. '
      + 'Requires the current model to accept image input; a text-only model is served a source-tagged text description when the deployment configures a vision slot.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          image: IMAGE_VALUE_SCHEMA,
          description: { type: 'string' },
          origin: { type: 'string' },
        },
      },
      render: (_args, value) => renderReadImageResult(value),
      // Persist the resolved path only. The attachment reference is NOT copied
      // here: the settled `content` already carries the image block with the
      // complete reference, so a second copy would keep two records of one fact —
      // and a `tools/post-execute` hook that legitimately replaces the content
      // would leave the stale copy behind, showing an image the result no longer
      // returns. The path needs its own structured record because the content
      // carries it only as model-facing envelope text, which the client does not
      // parse.
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Content-addressed attachment writes are idempotent, so concurrent reads
    // of the same file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      // Every pre-read gate runs before any filesystem I/O so a refusal never
      // leaks partial reads or attachment writes. An extension-less path
      // declares no format, so only its format and deployment media-type
      // checks wait for the bytes.
      const extension = extname(args.file_path).toLowerCase()
      const declared = imageMediaTypeForPath(args.file_path)
      if (declared === undefined && extension !== '') {
        throw new Error(`cannot read "${args.file_path}": the ${extension} extension does not declare a supported image format; read_image accepts PNG/JPEG/WebP/GIF files, including extension-less files in those formats`)
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`)
      }
      if (declared !== undefined) assertDeploymentAccepts(attachments, declared, args.file_path)
      const route = await assertImageCapableRoute(ctx, exec, args.file_path, privacy)

      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

      // The tool result is one message carrying one image, so the per-message
      // aggregate bound applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      const mediaType = declared ?? sniffImageMediaType(data)
      if (mediaType === undefined) {
        throw new Error(`cannot read "${target.displayPath}": the file content is not a supported image format; read_image accepts PNG/JPEG/WebP/GIF`)
      }
      if (declared === undefined) assertDeploymentAccepts(attachments, mediaType, target.displayPath)
      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended. The
      // vision digestion path commits the same way so the visual-assist call
      // can read the bytes back through the store.
      let ref: ImageAttachmentRef
      try {
        ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError)) throw error
        // Dimension refusals stay recoverable tool errors: an oversized image
        // must never enter durable history, where it would ride every later
        // model request past provider-side dimension rejections.
        if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": at least one image side exceeds the ${attachments.imageLimits.maxImageDimension}px limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
          throw new Error(
            `cannot read "${target.displayPath}": the image exceeds the ${attachments.imageLimits.maxImagePixels}-pixel decoded-size limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(error.message)) {
          throw new Error(
            `cannot read "${target.displayPath}": the 16-bit PNG could not be converted to the normalized 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`,
            { cause: error },
          )
        }
        if (error.code === 'INVALID_IMAGE' && declared === undefined) {
          throw new Error(
            `cannot read "${target.displayPath}": the bytes do not decode as a supported PNG/JPEG/WebP/GIF image; the file may be truncated or corrupt`,
            { cause: error },
          )
        }
        if (error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        if (declared === undefined) {
          throw new Error(
            `cannot read "${target.displayPath}": the file signature claims ${mediaType}, but the bytes decode as a different image format; the file may be corrupt`,
            { cause: error },
          )
        }
        throw new Error(
          `cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
          { cause: error },
        )
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      if (route.kind === 'vision') {
        // S-45 M3: digest through the vision slot and serve the main model a
        // source-tagged text description instead of the image bytes.
        const description = await describeImageWithVision(ctx, exec, route.slot, ref, mediaType)
        return { path: target.displayPath, description, origin: formatVisionOrigin(route.slot) }
      }
      const value: ImageReadValue = {
        path: ctx.fs.processPath(target),
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...ref.originalDimensions === undefined ? {} : {
            originalDimensions: { ...ref.originalDimensions },
          },
        },
      }
      return value
    },
    // Pure display: a generic card in the read family with a follow-along
    // location on the image file.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
