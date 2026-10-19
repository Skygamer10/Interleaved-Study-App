// Response schemas for Gemini structured output (generateContent `responseJsonSchema`, Interactions
// `response_format.schema`). Only the JSON Schema subset Gemini documents is typed here; keep schemas small
// (object root, no $ref, shallow nesting, short enums and item limits) to stay under its complexity limits.
export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface JsonSchema {
  type?: JsonType | JsonType[] // ['string', 'null'] for nullable
  title?: string
  description?: string
  enum?: (string | number)[]
  format?: 'date' | 'date-time' | 'time'
  minimum?: number
  maximum?: number
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  properties?: Record<string, JsonSchema>
  required?: string[]
  anyOf?: JsonSchema[]
}
