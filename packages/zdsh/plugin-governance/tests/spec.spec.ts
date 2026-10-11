/**
 * PluginSpec 单元测试
 */

import { describe, it, expect } from 'vitest'
import {
  PluginManifest,
  PluginStatus,
  PluginLevel,
  PluginCertification,
  SandboxType,
  normalizePluginId,
  validatePluginId,
} from '../src/spec/index.ts'

describe('PluginSpec', () => {
  describe('normalizePluginId', () => {
    it('should normalize namespace/name format', () => {
      expect(normalizePluginId('my-org/my-plugin')).toBe('my-org/my-plugin')
    })

    it('should normalize dsh-xxx / zdsh-xxx format', () => {
      expect(normalizePluginId('dsh-tools')).toBe('core/tools')
      // TC-O3（O3-S2 设计遗漏等量处理）：zdsh- 命名世代同折叠入 core/ 空间
      // （manifestFromLocalSource 以本函数派生准入身份；zdsh-workbench 先例）。
      expect(normalizePluginId('zdsh-tools')).toBe('core/tools')
      expect(normalizePluginId('zdsh-workbench')).toBe('core/workbench')
      // REVIEW-S3FIX 建议2 加固：裸前缀无后名 → 原样返回（不构造空名
      // 'core/'），validatePluginId 格式门拒收路径显式化，处置不变恒拒。
      expect(normalizePluginId('dsh-')).toBe('dsh-')
      expect(normalizePluginId('zdsh-')).toBe('zdsh-')
      expect(validatePluginId(normalizePluginId('dsh-'))).toBe(false)
      expect(validatePluginId(normalizePluginId('zdsh-'))).toBe(false)
    })

    it('should normalize @scope/name format', () => {
      expect(normalizePluginId('@deepseek-ai/dsh-core')).toBe('deepseek-ai/dsh-core')
    })
  })

  describe('validatePluginId', () => {
    it('should validate correct format', () => {
      expect(validatePluginId('my-org/my-plugin')).toBe(true)
      expect(validatePluginId('dsh/core-tools')).toBe(true)
    })

    it('should reject incorrect format', () => {
      expect(validatePluginId('invalid')).toBe(false)
      expect(validatePluginId('')).toBe(false)
      expect(validatePluginId('UPPER/case')).toBe(false)
      expect(validatePluginId('a/b')).toBe(false)
      expect(validatePluginId('ok-name/x')).toBe(false)
    })
  })

  describe('PluginManifest', () => {
    const validManifest: PluginManifest = {
      id: 'test/plugin',
      version: '1.0.0',
      name: 'Test Plugin',
      dsh: {
        compatible: '>=0.1.0-rc.8 <0.2.0',
      },
      capabilities: [
        {
          type: 'tool',
          tool: {
            name: 'test_tool',
            description: 'A test tool',
            schema: { type: 'object' },
          },
        },
      ],
      sandbox: {
        type: 'inline',
        resources: {
          memoryLimitMb: 128,
          cpuLimit: 50,
          timeoutMs: 30000,
          maxOutputBytes: 10000,
        },
        filesystem: {
          access: 'readonly',
          allowedPaths: ['/tmp'],
          deniedPatterns: [],
        },
        network: {
          access: 'none',
          allowedHosts: [],
          deniedHosts: [],
          allowLocal: false,
        },
        environment: {
          whitelist: [],
          blacklist: [],
          clear: false,
        },
        process: {
          spawn: false,
          exec: false,
          allowedCommands: [],
        },
      },
    }

    it('should create valid manifest', () => {
      expect(validManifest.id).toBe('test/plugin')
      expect(validManifest.version).toBe('1.0.0')
      expect(validManifest.capabilities).toHaveLength(1)
    })

    it('should have required fields', () => {
      expect(validManifest.id).toBeDefined()
      expect(validManifest.version).toBeDefined()
      expect(validManifest.name).toBeDefined()
      expect(validManifest.dsh).toBeDefined()
      expect(validManifest.capabilities).toBeDefined()
      expect(validManifest.sandbox).toBeDefined()
    })
  })

  describe('SandboxType', () => {
    it('excludes the unimplemented untrusted member (R-S43 消歧)', () => {
      // 编译期守卫：若有人重新把 'untrusted' 加回联合类型，该条件类型会
      // 判为 false，与右侧 true 的赋值产生类型错误，从而在编译期拦截
      // 「文档与守卫口径不一」的回归。
      const untrustedExcluded: 'untrusted' extends SandboxType ? false : true = true
      expect(untrustedExcluded).toBe(true)
    })
  })

  describe('PluginStatus', () => {
    it('should have all statuses', () => {
      expect(PluginStatus.ACTIVE).toBe('active')
      expect(PluginStatus.WARNINGS).toBe('warnings')
      expect(PluginStatus.DISABLED).toBe('disabled')
      expect(PluginStatus.ERROR).toBe('error')
      expect(PluginStatus.DEPRECATED).toBe('deprecated')
    })
  })

  describe('PluginLevel', () => {
    it('should have all levels', () => {
      expect(PluginLevel.READ_ONLY).toBe('read-only')
      expect(PluginLevel.WORKSPACE).toBe('workspace')
      expect(PluginLevel.SYSTEM).toBe('system')
    })
  })

  describe('PluginCertification', () => {
    it('should have all certification levels', () => {
      expect(PluginCertification.OFFICIAL).toBe('official')
      expect(PluginCertification.VERIFIED).toBe('verified')
      expect(PluginCertification.COMMUNITY).toBe('community')
      expect(PluginCertification.UNLISTED).toBe('unlisted')
    })
  })
})
