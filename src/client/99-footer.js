/* dsh-review-panel client half — module exports (ModuleLoader contract). */

exports.apply = apply
exports.inject = inject

// Offline smoke-test hook (scripts/smoke-client.mjs); never set in the browser.
if (globalThis.__DSH_REVIEW_PANEL_TEST__ === true) {
  exports.__test = {
    ReviewPage,
    ReviewTabBody,
    ReviewViewBody,
    FileTree,
    TreeDir,
    ChangesPill,
    EmptyState,
    HandoffCard,
    MonacoHost,
    buildRegions,
    toWorkspaceRel,
    absolutePathOf,
    fuzzyScore,
    rankQuickOpen,
    lspRegisterProviders,
    lspSymbols,
    lspSetDocument,
    PickerOverlay,
    detectScheme,
    editorColorsOf,
    schemeFromRenderedBackground,
    applyMonacoTheme,
    registerMonacoThemes,
    MONACO_THEME,
    loadMonaco,
    STYLE_TEXT,
  }
}

