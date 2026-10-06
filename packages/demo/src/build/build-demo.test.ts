import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEMO_ERROR_CODES } from '../errors.js'
import { buildDemo } from './build-demo.js'

describe('buildDemo', () => {
  it('refuses to build outside UTC before anything else, creating no directory', async () => {
    // Arrange
    const out = join(tmpdir(), `demo-zone-${String(process.pid)}`, 'small')

    // Act
    const building = buildDemo({ size: 'small', out })

    // Assert
    await expect(building).rejects.toMatchObject({ code: DEMO_ERROR_CODES.DEMO_TZ_NOT_UTC })
    expect({ zone: process.env.TZ, isCreated: existsSync(out) }).toStrictEqual({
      zone: 'America/St_Johns',
      isCreated: false,
    })
  })
})
