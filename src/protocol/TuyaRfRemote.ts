export const DP_SEND_IR = '201'
export const DP_LEARNED_ID = '202'
export const DP_LEARNED_REPORT = '2'

export interface RfSendOptions {
  times?: number
  delay?: number
  intervals?: number
  frequency?: number
  mode?: number
  rate?: number
  version?: string
}

export interface RfStudyOptions {
  frequency?: number
  version?: string
  short?: boolean
}

interface RfLearnedCode {
  ver?: string
  [key: string]: unknown
}

const DEFAULT_RF_VERSION = '2'
const DEFAULT_RF_FREQUENCY = 0

export function decodeLearnedRfCode(base64Code: string): RfLearnedCode | null {
  try {
    return JSON.parse(Buffer.from(base64Code, 'base64').toString('utf8'))
  } catch (_ex) {
    return null
  }
}

export function buildRfStudyCommand(options: RfStudyOptions = {}): Record<string, unknown> {
  return {
    control: options.short ? 'rf_shortstudy' : 'rf_study',
    rf_type: 'sub_2g',
    study_feq: String(options.frequency ?? DEFAULT_RF_FREQUENCY),
    ver: options.version || DEFAULT_RF_VERSION,
  }
}

export function buildRfStudyExitCommand(options: RfStudyOptions = {}): Record<string, unknown> {
  return {
    control: options.short ? 'rfshortstudy_exit' : 'rfstudy_exit',
    rf_type: 'sub_2g',
    study_feq: String(options.frequency ?? DEFAULT_RF_FREQUENCY),
    ver: options.version || DEFAULT_RF_VERSION,
  }
}

export function buildRfSendButtonCommand(base64Code: string, options: RfSendOptions = {}): Record<string, unknown> {
  const decoded = decodeLearnedRfCode(base64Code)
  const version = options.version || decoded?.ver || DEFAULT_RF_VERSION

  return {
    control: 'rfstudy_send',
    rf_type: 'sub_2g',
    feq: options.frequency ?? DEFAULT_RF_FREQUENCY,
    mode: options.mode || 0,
    rate: options.rate || 0,
    ver: version,
    key1: {
      code: base64Code,
      times: options.times || 6,
      delay: options.delay || 0,
      intervals: options.intervals || 0,
      ver: version,
    },
  }
}
