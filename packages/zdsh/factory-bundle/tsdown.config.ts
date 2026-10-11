import type { UserConfig } from 'tsdown'

/**
 * Pure factory-assembly artifact: this package owns no TypeScript sources, so
 * tsc never emits a lib/ for it and it declares no exports/main/types. The root
 * tsdown workspace layout (the packages group/name glob) still sweeps this
 * directory in and asks each package to resolve the Host entry
 * lib/types/{index,invariant,startup}.js — which cannot match here, so the Host
 * pass aborted with Cannot find entry.
 *
 * The documented repository precedent for removing a package from the workspace
 * build before entry resolution is a falsey entry in the package's own
 * tsdown.config.ts (see SKIP_WORKSPACE_BUILD in packages/client/
 * tsdown.client.ts: tsdown drops a package whose merged config.entry is falsy
 * and does not run the root defaults on it). A package-local override is the
 * right lever here because it registers the exclusion on the manifest package
 * itself, leaving the root Host and Client build faces untouched.
 */
const skipWorkspaceBuild: UserConfig = { entry: '' }

export default skipWorkspaceBuild
