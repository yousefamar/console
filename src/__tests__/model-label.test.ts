import { describe, it, expect } from 'vitest'
import { displayModel, isProfileArn, modelLabel } from '@/utils/model-label'

const ARN = 'arn:aws:bedrock:us-east-1:637423377122:application-inference-profile/oifqcw3zbemz'

describe('modelLabel', () => {
  it('labels bare first-party ids', () => {
    expect(modelLabel('claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('claude-fable-5')).toBe('Fable 5')
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
  })

  it('labels Bedrock-prefixed and versioned ids the same way', () => {
    expect(modelLabel('us.anthropic.claude-opus-5')).toBe('Opus 5')
    expect(modelLabel('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5')
  })

  it('returns null for non-Claude ids and ARNs', () => {
    expect(modelLabel(ARN)).toBeNull()
    expect(modelLabel('gpt-transcribe')).toBeNull()
  })
})

describe('isProfileArn', () => {
  it('recognises only bedrock ARNs', () => {
    expect(isProfileArn(ARN)).toBe(true)
    expect(isProfileArn('us.anthropic.claude-opus-5')).toBe(false)
  })
})

describe('displayModel', () => {
  it('resolves an ARN through a single candidate', () => {
    expect(displayModel(ARN, ['us.anthropic.claude-opus-5'])).toBe('Opus 5')
  })

  it('falls back to a generic label when candidates are ambiguous or absent', () => {
    expect(displayModel(ARN)).toBe('Bedrock profile')
    expect(displayModel(ARN, ['claude-opus-5', 'claude-fable-5'])).toBe('Bedrock profile')
  })

  it('accepts candidates that all name the same model', () => {
    expect(displayModel(ARN, ['claude-opus-5', 'us.anthropic.claude-opus-5'])).toBe('Opus 5')
  })

  it('never renders blank for an unknown id', () => {
    expect(displayModel('some-future-model')).toBe('some-future-model')
  })
})
