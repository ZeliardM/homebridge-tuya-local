import { describe, expect, it } from 'vitest'
import {
  buildRfSendButtonCommand,
  buildRfStudyCommand,
  buildRfStudyExitCommand,
  decodeLearnedRfCode,
} from '../src/protocol/TuyaRfRemote'

describe('Tuya RF remote helpers', () => {
  it('builds RF study commands for Tuya universal remotes', () => {
    expect(buildRfStudyCommand()).toMatchObject({
      study_feq: '0',
    })

    expect(buildRfStudyCommand({ frequency: 433, version: '2' })).toEqual({
      control: 'rf_study',
      rf_type: 'sub_2g',
      study_feq: '433',
      ver: '2',
    })

    expect(buildRfStudyExitCommand({ frequency: 433, version: '2' })).toEqual({
      control: 'rfstudy_exit',
      rf_type: 'sub_2g',
      study_feq: '433',
      ver: '2',
    })
  })

  it('preserves the learned RF code version when sending', () => {
    const code = Buffer.from(JSON.stringify({ ver: '7', study_feq: '433' }), 'utf8').toString('base64')

    expect(decodeLearnedRfCode(code)).toEqual({ ver: '7', study_feq: '433' })
    expect(buildRfSendButtonCommand(code)).toEqual({
      control: 'rfstudy_send',
      rf_type: 'sub_2g',
      feq: 0,
      mode: 0,
      rate: 0,
      ver: '7',
      key1: {
        code,
        times: 6,
        delay: 0,
        intervals: 0,
        ver: '7',
      },
    })
  })
})
