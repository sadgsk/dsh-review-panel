// Read-only LSP acceptance fixture: cross-file definition, hover, references and diagnostics.
import { DEFAULT_RETRY, delayFor } from './retry-policy'

export const previewDelay = delayFor(2, DEFAULT_RETRY)

// Intentional type error so the diagnostics UI can be checked without editing a real source file.
export const diagnosticFixture: number = 'expected type error'
