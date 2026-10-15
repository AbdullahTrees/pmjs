# Web compatibility surfaces

The web layer supplies the DOM and CSS contracts used by the native engine
integration. It does not include a browser layout or CSS painting engine.

HTML elements, canvases, images, scripts, audio and video inherit from
`HTMLElement`, `Element`, `Node` and `EventTarget`. Text nodes and the document
inherit from `Node`. Tree removal releases focus when the focused control is
inside the detached subtree. Descendant tag searches return matches in tree
order.

Element styles expose `CSSStyleDeclaration` property reads, writes and property
methods. Computed styles resolve inline values, inherited text properties,
named colors and basic defaults. Recognizing a property such as `transform`
does not itself make an arbitrary DOM element a native display object.
Registered font stylesheets expose their real `CSSFontFaceRule` entries through
`document.styleSheets`; inserted font rules also enter the native font registry.
When no requested family matches, registered main game fonts provide the
fallback. System font discovery is not provided.

Canvas linear and radial gradients share the `CanvasGradient` prototype.
Prototype extensions use the same color-stop validation and native paint data
as ordinary gradients.

Focused text controls accept committed SDL Unicode text, selection replacement,
length limits and editing keys. The reviewed input-form integration presents
its text field, submit button and controller character grid as engine windows.
It preserves the form's variable result and forced-close handling, and releases
its interpreter wait and input ownership when it closes. Session storage is
private to the current guest process and is discarded on reload.
