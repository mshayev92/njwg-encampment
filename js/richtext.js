/* ============================================================
   RICH TEXT — shared bold/italic/underline/list toolbar used by
   any page that lets a person format free text (Notes, Announcements).
   No external editor library: a plain contenteditable div driven by
   document.execCommand, plus a tag-allowlist sanitizer run on any
   HTML before it's ever injected back into the page via innerHTML.
   ============================================================ */

window.RichText = (function () {
  // Uses data-tooltip (the app's themed hover/focus bubble, wired by
  // Shell.wireTooltips after the toolbar is inserted) rather than the
  // native title="" tooltip the rest of the app deliberately replaced —
  // plus aria-label so each button has a clear accessible name beyond its
  // one-letter/short glyph.
  const TOOLBAR_HTML = `
    <div class="richtext-toolbar">
      <button type="button" data-cmd="bold" data-tooltip="Bold" aria-label="Bold"><b>B</b></button>
      <button type="button" data-cmd="italic" data-tooltip="Italic" aria-label="Italic"><i>I</i></button>
      <button type="button" data-cmd="underline" data-tooltip="Underline" aria-label="Underline"><u>U</u></button>
      <button type="button" data-cmd="insertUnorderedList" data-tooltip="Bulleted list" aria-label="Bulleted list">&#8226; List</button>
      <button type="button" data-cmd="insertOrderedList" data-tooltip="Numbered list" aria-label="Numbered list">1. List</button>
    </div>`;

  /** Wires up toolbar buttons found in toolbarEl to run execCommand on editorEl. */
  function attach(toolbarEl, editorEl) {
    toolbarEl.querySelectorAll("[data-cmd]").forEach((btn) => {
      // mousedown (not click) so the editor's text selection isn't lost
      // to focus-shifting before the command actually runs.
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        editorEl.focus();
        document.execCommand(btn.dataset.cmd, false, null);
      });
    });
  }

  // Only plain structure/formatting tags survive. Everything else
  // (script, style, img, a, iframe, on*-handlers, style= attributes,
  // javascript: hrefs, ...) is stripped — this is the actual XSS
  // defense, run again at DISPLAY time regardless of what was saved.
  const ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "UL", "OL", "LI", "BR", "P", "DIV", "SPAN"]);

  function clean(node) {
    Array.from(node.childNodes).forEach((child) => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        clean(child); // sanitize children first so unwrapping a disallowed
                       // parent can never reintroduce unsanitized content
        if (!ALLOWED_TAGS.has(child.tagName)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
        } else {
          Array.from(child.attributes).forEach((attr) => child.removeAttribute(attr.name));
        }
      } else if (child.nodeType !== Node.TEXT_NODE) {
        node.removeChild(child); // comments, processing instructions, etc.
      }
    });
  }

  function sanitize(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    clean(template.content);
    return template.innerHTML;
  }

  function isEmpty(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    return !template.content.textContent.trim();
  }

  return { TOOLBAR_HTML, attach, sanitize, isEmpty };
})();
