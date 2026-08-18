'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeUpdatePreferences } = require('../update-preferences.js')

test('旧版每周检查偏好迁移为默认启动检查并保留待更新版本', () => {
  const result = normalizeUpdatePreferences({
    weeklyUpdateCheck: false,
    lastUpdateCheckAt: 123,
    pendingUpdateVersion: '2.0.0',
  })
  assert.deepEqual(result.preferences, {
    checkUpdatesOnStartup: true,
    pendingUpdateVersion: '2.0.0',
  })
  assert.equal(result.needsMigration, true)
})

test('新版偏好保留用户关闭启动检查的选择', () => {
  const result = normalizeUpdatePreferences({
    checkUpdatesOnStartup: false,
    pendingUpdateVersion: null,
  })
  assert.equal(result.preferences.checkUpdatesOnStartup, false)
  assert.equal(result.needsMigration, false)
})
