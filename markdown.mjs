const URL_RE = /^(https?:\/\/|\/|#)/i;

export function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function safeUrl(value) {
  const url = String(value || "").trim();
  if (!URL_RE.test(url) || /^(javascript|vbscript|data):/i.test(url)) {
    return "#";
  }
  return escapeHtml(url);
}

function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
    return `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy" decoding="async">`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => {
    return `<a href="${safeUrl(url)}" rel="noopener noreferrer">${label}</a>`;
  });
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/_([^_]+)_/g, "<em>$1</em>");
  return text;
}

export function renderMarkdown(markdown = "") {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let listType = null;
  let code = null;

  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  };
  const closeParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      closeParagraph();
      closeList();
      if (code === null) {
        code = [];
      } else {
        output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(heading[1].length, 3);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(---+|\*\*\*+)$/.test(trimmed)) {
      closeParagraph();
      closeList();
      output.push("<hr>");
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeParagraph();
      closeList();
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const unordered = /^[-*+]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      closeParagraph();
      const nextType = ordered ? "ol" : "ul";
      if (listType !== nextType) {
        closeList();
        output.push(`<${nextType}>`);
        listType = nextType;
      }
      output.push(`<li>${inlineMarkdown((ordered || unordered)[1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  if (code !== null) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  closeParagraph();
  closeList();
  return output.join("\n");
}
