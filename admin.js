import { analyzeSeo } from "./seo-analysis.js?v=20260802-seo-v2";

const app = document.getElementById("admin-app");

const state = {
  user: null,
  posts: [],
  categories: [],
  view: "overview",
  editing: null,
  busy: false,
};

const statusLabels = {
  draft: "Bản nháp",
  published: "Đã xuất bản",
  scheduled: "Hẹn giờ",
};

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function dateLabel(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium" }).format(new Date(value));
}

function dateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function slugify(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 150);
}

// The editor stores Markdown for the existing publishing pipeline, but presents
// a familiar visual surface to non-technical writers.
function inlineMarkdownToHtml(value) {
  let html = esc(value);
  html = html.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, '<img src="$2" alt="$1">');
  html = html.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, '<a href="$2">$1</a>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  html = html.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>');
  return html;
}

function markdownToEditorHtml(markdown = "") {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let list = null;
  let quote = [];
  let code = false;
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote.length) { output.push(`<blockquote>${quote.map((line) => inlineMarkdownToHtml(line)).join("<br>")}</blockquote>`); quote = []; } };
  for (const line of lines) {
    if (/^```/.test(line.trim())) { closeList(); closeQuote(); code = !code; if (!code) output.push("</pre>"); else output.push("<pre><code>"); continue; }
    if (code) { output.push(esc(line) + "\n"); continue; }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) { closeList(); quote.push(quoteMatch[1]); continue; }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { closeList(); closeQuote(); const level = heading[1].length; output.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) { closeQuote(); const kind = unordered ? "ul" : "ol"; if (list !== kind) { closeList(); output.push(`<${kind}>`); list = kind; } output.push(`<li>${inlineMarkdownToHtml((unordered || ordered)[1])}</li>`); continue; }
    closeList(); closeQuote(); output.push(`<p>${inlineMarkdownToHtml(line)}</p>`);
  }
  closeList(); closeQuote();
  if (code) output.push("</code></pre>");
  return output.join("");
}

function editorNodeToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.replace(/\u00a0/g, " ");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const children = () => Array.from(node.childNodes).map(editorNodeToMarkdown).join("");
  const content = children();
  switch (node.tagName.toLowerCase()) {
    case "strong": case "b": return `**${content}**`;
    case "em": case "i": return `*${content}*`;
    case "code": return node.parentElement?.tagName.toLowerCase() === "pre" ? content : `\`${content}\``;
    case "a": return `[${content}](${node.getAttribute("href") || ""})`;
    case "img": return `![${node.getAttribute("alt") || "Ảnh nội dung"}](${node.getAttribute("src") || ""})`;
    case "br": return "\n";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return `${"#".repeat(Number(node.tagName.slice(1)))} ${content.trim()}\n\n`;
    case "p": case "div": return `${content.trim()}\n\n`;
    case "blockquote": return content.split("\n").filter(Boolean).map((line) => `> ${line}`).join("\n") + "\n\n";
    case "ul": return Array.from(node.children).map((item) => `- ${editorNodeToMarkdown(item).trim()}`).join("\n") + "\n\n";
    case "ol": return Array.from(node.children).map((item, index) => `${index + 1}. ${editorNodeToMarkdown(item).trim()}`).join("\n") + "\n\n";
    case "li": return content;
    case "pre": return "```\n" + content.replace(/\n+$/, "") + "\n```\n\n";
    default: return content;
  }
}

function editorHtmlToMarkdown(editor) {
  return Array.from(editor.childNodes).map(editorNodeToMarkdown).join("").replace(/\n{3,}/g, "\n\n").trim();
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Có lỗi xảy ra.");
  return data;
}

function loginView(message = "") {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-card" aria-labelledby="login-title">
        <div class="brand-mark"><strong>THE COMMA</strong><span>EDITORIAL<br>STUDIO</span></div>
        <h1 id="login-title">Không gian<br><em>biên tập.</em></h1>
        <p>Một tài khoản chung để đội ngũ The Comma viết, chỉnh sửa và xuất bản những câu chuyện về đồ uống, nguyên liệu và mùa.</p>
        <form id="login-form">
          <div class="field"><label for="login-username">Tên đăng nhập</label><input id="login-username" name="username" autocomplete="username" required autofocus></div>
          <div class="field"><label for="login-password">Mật khẩu</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div>
          <label class="password-toggle" for="show-login-password"><input id="show-login-password" type="checkbox"><span>Hiện mật khẩu</span></label>
          <button class="button button-primary" type="submit">Đăng nhập vào studio ↗</button>
          <div class="message" role="alert">${esc(message)}</div>
        </form>
      </section>
    </main>`;
  const passwordInput = document.getElementById("login-password");
  document.getElementById("show-login-password").addEventListener("change", (event) => {
    passwordInput.type = event.currentTarget.checked ? "text" : "password";
  });
  document.getElementById("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    button.textContent = "Đang kiểm tra…";
    try {
      const result = await apiRequest("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      state.user = result.user;
      if (!state.user.mustChangePassword) {
        await loadAdminData();
        state.view = "overview";
      }
      render();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Đăng nhập vào studio ↗";
      const messageNode = event.currentTarget.querySelector(".message");
      messageNode.textContent = error.message;
    }
  });
}

function requiredPasswordChangeView() {
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-card" aria-labelledby="password-change-title">
        <div class="brand-mark"><strong>THE COMMA</strong><span>EDITORIAL<br>STUDIO</span></div>
        <p class="eyebrow">Bước bảo mật bắt buộc</p>
        <h1 id="password-change-title">Tạo mật khẩu<br><em>của riêng bạn.</em></h1>
        <p>Đây là lần đăng nhập đầu tiên. Hãy đổi mật khẩu tạm thời trước khi vào Content Studio.</p>
        <form id="forced-password-form">
          <div class="field"><label for="forced-current-password">Mật khẩu tạm thời</label><input id="forced-current-password" name="currentPassword" type="password" autocomplete="current-password" required autofocus></div>
          <div class="field"><label for="forced-new-password">Mật khẩu mới</label><input id="forced-new-password" name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div>
          <div class="field"><label for="forced-confirm-password">Nhập lại mật khẩu mới</label><input id="forced-confirm-password" name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div>
          <button class="button button-primary" type="submit">Đổi mật khẩu và tiếp tục ↗</button>
          <div class="message" id="password-message" role="alert"></div>
        </form>
      </section>
    </main>`;
  document.getElementById("forced-password-form").addEventListener("submit", submitPasswordForm);
}

function sidebar(active) {
  return `
    <aside class="admin-sidebar">
      <div class="sidebar-brand"><strong>THE COMMA</strong><span>STORIES STUDIO</span><button class="mobile-menu-toggle" type="button" data-menu-toggle aria-expanded="false" aria-controls="sidebar-menu" aria-label="Mở menu"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.7"/></svg></button></div>
      <div class="sidebar-menu" id="sidebar-menu">
        <nav class="sidebar-nav" aria-label="Quản trị">
        <button data-view="overview" class="${active === "overview" ? "active" : ""}">Tổng quan</button>
        <button data-view="stories" class="${active === "stories" ? "active" : ""}">Stories</button>
        <button data-view="editor" class="${active === "editor" ? "active" : ""}">Viết bài mới</button>
        <button data-view="categories" class="${active === "categories" ? "active" : ""}">Quản lý chuyên mục</button>
        <button data-view="settings" class="${active === "settings" ? "active" : ""}">Cài đặt</button>
        </nav>
        <div class="sidebar-bottom"><div class="user-chip"><b>${esc(state.user?.name || "The Comma Editor")}</b>${esc(state.user?.username || "")}</div><button id="logout-button">Đăng xuất ↗</button></div>
      </div>
    </aside>`;
}

function shell(title, description, content) {
  return `<div class="admin-layout">${sidebar(state.view)}<main class="admin-main"><header class="main-top"><div><p class="eyebrow">THE COMMA — STORIES STUDIO</p><h1>${title}</h1></div><p>${description}</p></header>${content}</main></div>`;
}

function overviewView() {
  const published = state.posts.filter((post) => post.status === "published").length;
  const drafts = state.posts.filter((post) => post.status === "draft").length;
  const scheduled = state.posts.filter((post) => post.status === "scheduled").length;
  const recent = state.posts.slice(0, 5);
  return shell("Tổng quan.", "Một bàn biên tập gọn nhẹ để đẩy story vào /stories/.", `
    <section class="stats-grid">
      <div class="stat"><span>Tổng bài viết</span><b>${state.posts.length}</b></div>
      <div class="stat"><span>Đã xuất bản</span><b>${published}</b></div>
      <div class="stat"><span>Bản nháp / hẹn giờ</span><b>${drafts + scheduled}</b></div>
    </section>
    <section class="panel publish-panel"><div class="panel-title"><div><h2>Đẩy sang Stories</h2><span>Xuất bản lại toàn bộ bài public thành website tĩnh tại /stories/.</span></div><button class="button button-primary button-small" data-publish-stories>Xuất bản ngay</button></div>
      <p class="subtle">Nút này sẽ sinh lại <code>stories/index.html</code>, <code>stories/story-manifest.json</code> và từng trang bài viết từ dữ liệu đã xuất bản.</p>
    </section>
    <section class="panel"><div class="panel-title"><h2>Mới cập nhật</h2><span>${state.posts.length ? "Theo thứ tự chỉnh sửa gần nhất" : "Chưa có bài trong studio"}</span></div>
      ${recent.length ? postsTable(recent) : '<div class="empty-state">Bắt đầu bằng một story đầu tiên. Nội dung xuất bản sẽ tự xuất hiện tại /stories.</div>'}
    </section>`);
}

function postsTable(posts) {
  return `<div class="table-wrap"><table class="posts-table"><thead><tr><th>Story</th><th>Trạng thái</th><th>Cập nhật</th><th></th></tr></thead><tbody>${posts.map((post) => `
    <tr><td><div class="post-title">${esc(post.title)}</div><span class="post-meta">/stories/${esc(post.slug)}/ · ${esc(post.category)}</span></td>
    <td data-label="Trạng thái"><span class="status-pill status-${esc(post.status)}">${esc(statusLabels[post.status] || post.status)}</span></td>
    <td data-label="Cập nhật">${dateLabel(post.updatedAt)}</td>
    <td><div class="row-actions"><button class="button button-quiet button-small" data-edit="${esc(post._id)}">Sửa</button><button class="button button-danger button-small" data-delete="${esc(post._id)}">Xóa</button></div></td></tr>`).join("")}</tbody></table></div>`;
}

function postsView() {
  return shell("Stories.", "Viết, chỉnh và xuất bản những câu chuyện sẽ đi vào /stories/.", `
    <section class="panel"><div class="panel-title"><h2>Tất cả stories</h2><div class="row-actions"><button class="button button-quiet button-small" data-publish-stories>Xuất bản tĩnh</button><button class="button button-primary button-small" data-view="editor">+ Viết story</button></div></div>
      ${state.posts.length ? postsTable(state.posts) : '<div class="empty-state">Chưa có story nào. Hãy tạo story đầu tiên.</div>'}
    </section>`);
}

function seoAssistantHtml(post = {}) {
  const result = analyzeSeo(post, "thecomma");
  const tone = result.signal === "good" ? "seo-good" : result.signal === "ok" ? "seo-ok" : "seo-bad";
  const visible = result.issues.filter((issue) => issue.severity !== "good").slice(0, 3);
  return `<section class="seo-assistant ${tone}" id="seo-assistant" aria-live="polite"><div class="seo-head"><div><p class="eyebrow">TRỢ LÝ SEO</p><h3>Gợi ý tối ưu story</h3></div><div class="seo-score"><strong>${result.score}/100</strong><span>${esc(result.label)}</span></div></div><div class="seo-counts"><span>${result.errorCount} đỏ</span><span>${result.warningCount} cam</span><span>${result.goodCount} xanh</span></div>${visible.length ? visible.map((issue) => `<article class="seo-issue ${issue.severity}"><div class="seo-issue-title"><i></i><b>${esc(issue.title)}</b><span>${issue.severity === "error" ? "Cần sửa" : "Cần cải thiện"}</span></div><p>${esc(issue.detail)}</p><small>${esc(issue.suggestion)}</small></article>`).join("") : '<p class="seo-clear">Các tiêu chí chính đang ổn. Có thể xuất bản sau khi rà soát lần cuối.</p>'}<div class="seo-stats"><span>${result.stats.wordCount} từ</span><span>${result.stats.sentenceCount} câu</span><span>${result.stats.headingCount} heading</span><span>${result.stats.imageCount} ảnh</span></div></section>`;
}

function categoryMenuHtml(selectedName) {
  const options = state.categories.length
    ? state.categories.map((category) => `
        <button type="button" class="category-option" role="option" aria-selected="${category.name === selectedName}" data-category-name="${esc(category.name)}">
          <span>${esc(category.name)}</span><small>${category.postCount} bài</small>
        </button>`).join("")
    : '<div class="category-empty">Chưa có chuyên mục nào.</div>';
  return `${options}<div class="category-menu-footer"><button type="button" class="category-create-action" data-create-category>+ Tạo chuyên mục mới</button></div>`;
}

function categoriesView() {
  const rows = state.categories.map((category) => `
    <tr>
      <td><div class="category-title">${esc(category.name)}</div></td>
      <td data-label="Số bài"><span class="category-count">${category.postCount} story</span></td>
      <td data-label="Cập nhật">${dateLabel(category.updatedAt)}</td>
      <td><div class="row-actions"><button class="button button-quiet button-small" data-category-edit="${esc(category._id)}">Sửa</button><button class="button button-danger button-small" data-category-delete="${esc(category._id)}" ${category.postCount ? 'disabled title="Hãy chuyển các bài sang chuyên mục khác trước khi xóa"' : ""}>Xóa</button></div></td>
    </tr>`).join("");
  return shell("Quản lý chuyên mục.", "Tạo danh mục dùng chung để người viết chọn nhanh và giữ Tạp chí The Comma nhất quán.", `
    <section class="panel"><div class="panel-title"><div><h2>Tất cả chuyên mục</h2><span>${state.categories.length} chuyên mục đang dùng trong Content Studio</span></div><button class="button button-primary button-small" data-category-create-page>+ Thêm chuyên mục</button></div>
      ${rows ? `<div class="table-wrap"><table class="posts-table categories-table"><thead><tr><th>Chuyên mục</th><th>Story</th><th>Cập nhật</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="empty-state">Chưa có chuyên mục. Hãy tạo chuyên mục đầu tiên.</div>'}
      <p class="category-note">Chuyên mục đang có story sẽ không thể xóa. Hãy chuyển các bài sang chuyên mục khác trước.</p>
    </section>`);
}

function editorView() {
  const post = state.editing || { title: "", slug: "", excerpt: "", content: "", focusKeyword: "", coverImage: "", category: state.categories[0]?.name || "", tags: [], status: "draft", author: state.user?.name || "The Comma Coffee", scheduledAt: null };
  const isEdit = Boolean(state.editing?._id);
  return shell(isEdit ? "Sửa story." : "Viết story mới.", "Soạn thảo trực quan cho bài sẽ xuất bản vào /stories/.", `
    <form id="post-form" class="editor-layout">
      <div class="editor-card">
        <div class="field"><label for="post-title">Tiêu đề story</label><input id="post-title" name="title" maxlength="160" value="${esc(post.title)}" required></div>
        <div class="field"><label for="post-slug">Slug URL</label><input id="post-slug" name="slug" maxlength="160" value="${esc(post.slug)}" required><span class="subtle">https://thecommacoffee.com/stories/<span id="slug-preview">${esc(post.slug || "slug-story")}</span>/</span></div>
        <div class="field"><label for="post-excerpt">Mô tả ngắn</label><textarea id="post-excerpt" name="excerpt" maxlength="500" required>${esc(post.excerpt)}</textarea></div>
        <div class="field"><label for="post-content-editor">Nội dung story</label>
          <div class="rich-editor" data-rich-editor>
            <div class="editor-toolbar" role="toolbar" aria-label="Công cụ định dạng">
              <button type="button" data-editor-format="p" title="Đoạn văn">☰</button><button type="button" data-editor-format="h2" title="Tiêu đề lớn">H2</button><button type="button" data-editor-format="h3" title="Tiêu đề nhỏ">H3</button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button type="button" data-editor-command="bold" title="Đậm"><strong>B</strong></button><button type="button" data-editor-command="italic" title="Nghiêng"><em>I</em></button><button type="button" data-editor-command="underline" title="Gạch chân"><u>U</u></button><button type="button" data-editor-command="strikeThrough" title="Gạch ngang">S</button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button type="button" data-editor-command="formatBlock" data-editor-value="blockquote" title="Trích dẫn">❞</button><button type="button" data-editor-command="insertUnorderedList" title="Danh sách">☷</button><button type="button" data-editor-command="insertOrderedList" title="Danh sách đánh số">☰</button><button type="button" data-editor-command="justifyLeft" title="Căn trái">≡</button><button type="button" data-editor-command="justifyCenter" title="Căn giữa">≡</button>
              <span class="toolbar-divider" aria-hidden="true"></span>
              <button type="button" data-editor-link title="Chèn liên kết">↗</button><button type="button" data-editor-image title="Chèn ảnh">▧ Media</button><button type="button" data-editor-command="undo" title="Hoàn tác">↶</button><button type="button" data-editor-command="redo" title="Làm lại">↷</button><button type="button" data-editor-command="removeFormat" title="Xóa định dạng">Tx</button>
              <input id="content-image-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            </div>
            <div id="post-content-editor" class="rich-editor-surface" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Nội dung bài viết">${markdownToEditorHtml(post.content)}</div>
            <textarea id="post-content" name="content" class="content-source" maxlength="100000" tabindex="-1" aria-hidden="true" required>${esc(post.content)}</textarea>
            <div class="editor-footer"><span class="subtle">Chọn đoạn văn, bôi đen chữ rồi dùng thanh công cụ để định dạng.</span><button type="button" class="editor-html-toggle" data-editor-html>Xem HTML</button><span id="editor-word-count" class="subtle">0 từ</span></div>
          </div>
        </div>
        <div class="form-actions"><button class="button button-primary" type="submit">${isEdit ? "Lưu thay đổi" : "Tạo story"} ↗</button><button class="button button-quiet" type="button" data-view="stories">Hủy</button><span class="message" id="post-message" role="alert"></span></div>
      </div>
      <div class="editor-side">
        ${seoAssistantHtml(post)}
        <div class="editor-card">
          <div class="split-fields"><div class="field"><label id="post-category-label">Chuyên mục</label><div class="category-picker" id="category-picker"><input id="post-category" name="category" type="hidden" value="${esc(post.category)}"><button id="category-trigger" class="category-trigger" type="button" aria-labelledby="post-category-label category-selected-label" aria-haspopup="listbox" aria-expanded="false"><span id="category-selected-label">${esc(post.category || "Chọn chuyên mục")}</span><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 7.5 5 5 5-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg></button><div id="category-menu" class="category-menu" role="listbox" aria-label="Danh sách chuyên mục" hidden>${categoryMenuHtml(post.category)}</div></div></div><div class="field"><label for="post-author">Tác giả</label><input id="post-author" name="author" maxlength="80" value="${esc(post.author)}" required></div></div>
          <div class="field"><label for="post-focus-keyword">Từ khóa chính</label><input id="post-focus-keyword" name="focusKeyword" value="${esc(post.focusKeyword || post.tags?.[0] || "")}" placeholder="vd: cà phê cold brew"></div>
          <div class="field"><label for="post-tags">Thẻ</label><input id="post-tags" name="tags" value="${esc((post.tags || []).join(", "))}" placeholder="cà phê, trải nghiệm"></div>
          <div class="field"><label for="post-status">Trạng thái</label><select id="post-status" name="status"><option value="draft" ${post.status === "draft" ? "selected" : ""}>Bản nháp</option><option value="published" ${post.status === "published" ? "selected" : ""}>Xuất bản ngay</option><option value="scheduled" ${post.status === "scheduled" ? "selected" : ""}>Hẹn giờ</option></select></div>
          <div class="field" id="schedule-field" style="display:${post.status === "scheduled" ? "grid" : "none"}"><label for="post-scheduled">Thời điểm xuất bản</label><input id="post-scheduled" name="scheduledAt" type="datetime-local" value="${dateInputValue(post.scheduledAt)}"></div>
          <div class="field"><label for="post-cover">Ảnh cover URL</label><input id="post-cover" name="coverImage" value="${esc(post.coverImage || "")}" placeholder="/uploads/blog/…"><input id="cover-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><img id="cover-preview" class="cover-preview ${post.coverImage ? "visible" : ""}" src="${esc(post.coverImage || "")}" alt="Xem trước ảnh cover"></div>
        </div>
        <div class="help-card"><h3>Nhịp của The Comma.</h3><p>Một story tốt bắt đầu từ nguyên liệu và trải nghiệm có thể xác minh, rồi kể vừa đủ để người đọc muốn ghé quán.</p><ul><li>Viết rõ, có cấu trúc.</li><li>Không thêm công thức hoặc nguồn gốc chưa xác nhận.</li><li>Kiểm tra ảnh và đường dẫn trước khi xuất bản.</li></ul></div>
      </div>
    </form>`);
}

function settingsView() {
  return shell("Cài đặt.", "Tài khoản biên tập chung của Stories Studio. Nên đổi mật khẩu sau lần đăng nhập đầu tiên.", `
    <section class="panel"><div class="panel-title"><h2>Đổi mật khẩu</h2><span>Bảo vệ không gian biên tập</span></div>
      <form id="password-form" class="editor-card" style="max-width:560px"><div class="field"><label>Mật khẩu hiện tại</label><input name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label>Mật khẩu mới</label><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label>Nhập lại mật khẩu mới</label><input name="confirmPassword" type="password" minlength="8" autocomplete="new-password" required></div><div class="form-actions"><button class="button button-primary" type="submit">Cập nhật mật khẩu ↗</button><span class="message" id="password-message" role="alert"></span></div></form>
    </section>`);
}

function render() {
  if (!state.user) return loginView();
  if (state.user.mustChangePassword) return requiredPasswordChangeView();
  if (state.view === "stories") app.innerHTML = postsView();
  else if (state.view === "editor") app.innerHTML = editorView();
  else if (state.view === "categories") app.innerHTML = categoriesView();
  else if (state.view === "settings") app.innerHTML = settingsView();
  else app.innerHTML = overviewView();
  bindShellEvents();
}

function bindShellEvents() {
  const menuToggle = document.querySelector("[data-menu-toggle]");
  const menu = document.getElementById("sidebar-menu");
  menuToggle?.addEventListener("click", () => {
    const isOpen = menu?.classList.toggle("is-open") || false;
    menuToggle.setAttribute("aria-expanded", String(isOpen));
    menuToggle.setAttribute("aria-label", isOpen ? "Đóng menu" : "Mở menu");
  });
  menuToggle?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu?.classList.contains("is-open")) {
      menu.classList.remove("is-open");
      menuToggle.setAttribute("aria-expanded", "false");
      menuToggle.setAttribute("aria-label", "Mở menu");
    }
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    if (state.view !== "editor") state.editing = null;
    render();
  }));
  document.getElementById("logout-button")?.addEventListener("click", async () => {
    await apiRequest("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
    state.user = null;
    state.posts = [];
    state.categories = [];
    render();
  });
  document.querySelector("[data-publish-stories]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "Đang xuất bản…";
    try {
      const result = await apiRequest("/api/admin/publish-stories", { method: "POST", body: "{}" });
      window.alert(`Đã xuất bản ${result.published || 0} story.`);
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  });
  document.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => {
    state.editing = state.posts.find((post) => post._id === button.dataset.edit) || null;
    state.view = "editor";
    render();
  }));
  document.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", async () => {
    const post = state.posts.find((item) => item._id === button.dataset.delete);
    if (!post || !window.confirm(`Xóa bài “${post.title}”?`)) return;
    button.disabled = true;
    try { await apiRequest(`/api/admin/posts/${encodeURIComponent(post._id)}`, { method: "DELETE", body: "{}" }); await loadAdminData(); render(); }
    catch (error) { window.alert(error.message); button.disabled = false; }
  }));
  document.querySelector("[data-category-create-page]")?.addEventListener("click", () => {
    openCategoryDialog({
      onSaved: async () => {
        await loadCategories();
        render();
      },
    });
  });
  document.querySelectorAll("[data-category-edit]").forEach((button) => button.addEventListener("click", () => {
    const category = state.categories.find((item) => item._id === button.dataset.categoryEdit);
    if (!category) return;
    openCategoryDialog({
      category,
      onSaved: async () => {
        await loadAdminData();
        render();
      },
    });
  }));
  document.querySelectorAll("[data-category-delete]").forEach((button) => button.addEventListener("click", async () => {
    const category = state.categories.find((item) => item._id === button.dataset.categoryDelete);
    if (!category || category.postCount || !window.confirm(`Xóa chuyên mục “${category.name}”?`)) return;
    button.disabled = true;
    try {
      await apiRequest(`/api/admin/categories/${encodeURIComponent(category._id)}`, { method: "DELETE", body: "{}" });
      await loadCategories();
      render();
    } catch (error) {
      window.alert(error.message);
      button.disabled = false;
    }
  }));
  const form = document.getElementById("post-form");
  if (form) bindPostForm(form);
  const passwordForm = document.getElementById("password-form");
  if (passwordForm) passwordForm.addEventListener("submit", submitPasswordForm);
}

function bindPostForm(form) {
  bindCategoryPicker(form);
  bindRichEditor(form);
  const title = form.elements.title;
  const slug = form.elements.slug;
  let slugTouched = Boolean(slug.value);
  slug.addEventListener("input", () => { slugTouched = true; updateSlugPreview(slug); });
  title.addEventListener("input", () => { if (!slugTouched) slug.value = slugify(title.value); updateSlugPreview(slug); });
  const refreshSeo = () => {
    const data = Object.fromEntries(new FormData(form).entries());
    data.content = form.querySelector("#post-content")?.value || data.content || "";
    data.tags = String(data.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const node = document.getElementById("seo-assistant");
    if (node) node.outerHTML = seoAssistantHtml(data);
  };
  ["title", "slug", "excerpt", "focusKeyword", "tags", "coverImage"].forEach((name) => form.elements[name]?.addEventListener("input", refreshSeo));
  form.querySelector("#post-content")?.addEventListener("input", refreshSeo);
  form.querySelector("#post-content-editor")?.addEventListener("input", () => setTimeout(refreshSeo, 0));
  updateSlugPreview(slug);
  refreshSeo();
  form.elements.status.addEventListener("change", () => {
    document.getElementById("schedule-field").style.display = form.elements.status.value === "scheduled" ? "grid" : "none";
  });
  form.elements.coverImage.addEventListener("input", () => updateCoverPreview(form.elements.coverImage.value));
  document.getElementById("cover-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const message = document.getElementById("post-message");
    message.textContent = "Đang tải ảnh lên…";
    try {
      const body = new FormData(); body.append("file", file);
      const result = await apiRequest("/api/admin/upload", { method: "POST", body });
      form.elements.coverImage.value = result.url;
      updateCoverPreview(result.url);
      message.textContent = "Ảnh đã được tải lên.";
    } catch (error) { message.textContent = error.message; }
  });
  form.addEventListener("submit", submitPostForm);
}

function bindRichEditor(form) {
  const editor = form.querySelector("[data-rich-editor]");
  const surface = document.getElementById("post-content-editor");
  const source = document.getElementById("post-content");
  const count = document.getElementById("editor-word-count");
  if (!editor || !surface || !source) return;
  let savedRange = null;
  const sync = () => {
    source.value = editorHtmlToMarkdown(surface);
    const words = surface.innerText.trim().split(/\s+/).filter(Boolean).length;
    if (count) count.textContent = `${words} từ`;
  };
  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && surface.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    if (!savedRange) return;
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(savedRange);
  };
  surface.addEventListener("input", sync);
  surface.addEventListener("keyup", rememberSelection);
  surface.addEventListener("mouseup", rememberSelection);
  surface.addEventListener("blur", rememberSelection);
  editor.querySelectorAll("[data-editor-command]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => { restoreSelection(); surface.focus(); document.execCommand(button.dataset.editorCommand, false, button.dataset.editorValue || null); sync(); });
  });
  editor.querySelectorAll("[data-editor-format]").forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
  editor.querySelectorAll("[data-editor-format]").forEach((button) => button.addEventListener("click", () => {
    restoreSelection(); surface.focus(); document.execCommand("formatBlock", false, `<${button.dataset.editorFormat}>`); sync();
  }));
  editor.querySelector("[data-editor-html]")?.addEventListener("click", (event) => {
    const sourceMode = editor.classList.toggle("source-visible");
    if (sourceMode) { sync(); source.removeAttribute("aria-hidden"); event.currentTarget.textContent = "Trình soạn thảo trực quan"; }
    else { surface.innerHTML = markdownToEditorHtml(source.value); source.setAttribute("aria-hidden", "true"); event.currentTarget.textContent = "Xem HTML"; sync(); }
  });
  editor.querySelector("[data-editor-link]")?.addEventListener("click", () => {
    restoreSelection(); surface.focus();
    const selection = window.getSelection();
    if (!selection?.toString().trim()) { window.alert("Hãy bôi đen phần chữ cần gắn liên kết trước."); return; }
    const url = window.prompt("Địa chỉ liên kết (https://…)", "https://");
    if (url && url !== "https://") { document.execCommand("createLink", false, url.trim()); sync(); }
  });
  editor.querySelector("[data-editor-image]")?.addEventListener("click", () => { rememberSelection(); editor.querySelector("#content-image-file")?.click(); });
  editor.querySelector("#content-image-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    const message = document.getElementById("post-message");
    message.textContent = "Đang tải ảnh nội dung lên…";
    try {
      const body = new FormData(); body.append("file", file);
      const result = await apiRequest("/api/admin/upload", { method: "POST", body });
      restoreSelection(); surface.focus();
      document.execCommand("insertHTML", false, `<img src="${esc(result.url)}" alt="${esc(file.name.replace(/\.[^.]+$/, ""))}">`);
      sync(); message.textContent = "Ảnh nội dung đã được chèn.";
    } catch (error) { message.textContent = error.message; }
    event.target.value = "";
  });
  sync();
}

function bindCategoryPicker(form) {
  const picker = document.getElementById("category-picker");
  const trigger = document.getElementById("category-trigger");
  const menu = document.getElementById("category-menu");
  const input = document.getElementById("post-category");
  const label = document.getElementById("category-selected-label");
  if (!picker || !trigger || !menu || !input || !label) return;

  const closeMenu = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const setSelected = (name) => {
    input.value = name;
    label.textContent = name || "Chọn chuyên mục";
  };
  const refreshOptions = (selectedName) => {
    setSelected(selectedName);
    menu.innerHTML = categoryMenuHtml(selectedName);
  };

  trigger.addEventListener("click", () => {
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-category-name]");
    if (option) {
      refreshOptions(option.dataset.categoryName);
      closeMenu();
      trigger.focus();
      return;
    }
    if (event.target.closest("[data-create-category]")) {
      closeMenu();
      openCategoryDialog({
        onSaved: async (category) => {
          await loadCategories();
          refreshOptions(category.name);
          trigger.focus();
        },
      });
    }
  });
  form.addEventListener("click", (event) => {
    if (!picker.contains(event.target)) closeMenu();
  });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeMenu();
      trigger.focus();
    }
  });
}

function openCategoryDialog({ category = null, onSaved } = {}) {
  document.querySelector(".category-dialog-backdrop")?.remove();
  const previousFocus = document.activeElement;
  const dialog = document.createElement("div");
  dialog.className = "category-dialog-backdrop";
  dialog.innerHTML = `
    <section class="category-dialog" role="dialog" aria-modal="true" aria-labelledby="category-dialog-title">
      <p class="eyebrow">THE COMMA — STORIES STUDIO</p>
      <h2 id="category-dialog-title">${category ? "Sửa chuyên mục." : "Tạo chuyên mục mới."}</h2>
      <p>${category ? "Tên mới sẽ được cập nhật cho tất cả story đang dùng chuyên mục này." : "Chuyên mục mới sẽ xuất hiện ngay trong danh sách chọn và trang quản lý."}</p>
      <form id="category-dialog-form">
        <div class="field"><label for="category-dialog-name">Tên chuyên mục</label><input id="category-dialog-name" name="name" minlength="2" maxlength="60" value="${esc(category?.name || "")}" autocomplete="off" required></div>
        <div class="form-actions"><button class="button button-primary" type="submit">${category ? "Lưu thay đổi" : "Tạo chuyên mục"} ↗</button><button class="button button-quiet" type="button" data-category-cancel>Hủy</button></div>
        <div class="message" id="category-dialog-message" role="alert"></div>
      </form>
    </section>`;
  document.body.appendChild(dialog);

  const form = dialog.querySelector("form");
  const input = form.elements.name;
  const close = () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  dialog.querySelector("[data-category-cancel]").addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const message = document.getElementById("category-dialog-message");
    button.disabled = true;
    message.textContent = category ? "Đang cập nhật…" : "Đang tạo…";
    try {
      const endpoint = category
        ? `/api/admin/categories/${encodeURIComponent(category._id)}`
        : "/api/admin/categories";
      const result = await apiRequest(endpoint, {
        method: category ? "PATCH" : "POST",
        body: JSON.stringify({ name: input.value }),
      });
      await onSaved?.(result.category || { name: input.value.trim() });
      close();
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
      input.focus();
    }
  });
  input.focus();
  input.select();
}

function updateSlugPreview(slug) { const node = document.getElementById("slug-preview"); if (node) node.textContent = slug.value || "slug-story"; }
function updateCoverPreview(url) { const image = document.getElementById("cover-preview"); if (!image) return; image.src = url; image.classList.toggle("visible", Boolean(url)); }

async function submitPostForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("post-message");
  const button = form.querySelector("button[type=submit]");
  const data = Object.fromEntries(new FormData(form).entries());
  const editor = document.getElementById("post-content-editor");
  const richEditor = form.querySelector("[data-rich-editor]");
  if (editor) data.content = richEditor?.classList.contains("source-visible") ? document.getElementById("post-content").value : editorHtmlToMarkdown(editor);
  if (!data.category) {
    message.textContent = "Vui lòng chọn hoặc tạo một chuyên mục.";
    document.getElementById("category-trigger")?.focus();
    return;
  }
  data.tags = String(data.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  if (data.status === "scheduled") data.scheduledAt = new Date(data.scheduledAt).getTime();
  else delete data.scheduledAt;
  delete data["cover-file"];
  button.disabled = true;
  message.textContent = "Đang lưu…";
  try {
    if (state.editing?._id) await apiRequest(`/api/admin/posts/${encodeURIComponent(state.editing._id)}`, { method: "PATCH", body: JSON.stringify(data) });
    else await apiRequest("/api/admin/posts", { method: "POST", body: JSON.stringify(data) });
    await loadAdminData(); state.editing = null; state.view = "stories"; render();
  } catch (error) { message.textContent = error.message; button.disabled = false; }
}

async function submitPasswordForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.getElementById("password-message");
  const values = Object.fromEntries(new FormData(form).entries());
  if (values.newPassword !== values.confirmPassword) { message.textContent = "Hai lần nhập mật khẩu mới chưa giống nhau."; return; }
  if (values.newPassword === values.currentPassword) { message.textContent = "Mật khẩu mới phải khác mật khẩu tạm thời."; return; }
  const forced = state.user?.mustChangePassword === true;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  message.textContent = "Đang cập nhật…";
  try {
    await apiRequest("/api/admin/change-password", { method: "POST", body: JSON.stringify(values) });
    state.user.mustChangePassword = false;
    if (forced) {
      await loadAdminData();
      state.view = "overview";
      render();
      return;
    }
    form.reset();
    message.textContent = "Đã cập nhật mật khẩu.";
    button.disabled = false;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
}

async function loadPosts() {
  const result = await apiRequest("/api/admin/posts");
  state.posts = result.posts || [];
}

async function loadCategories() {
  const result = await apiRequest("/api/admin/categories");
  state.categories = result.categories || [];
}

async function loadAdminData() {
  await Promise.all([loadPosts(), loadCategories()]);
}

async function init() {
  try {
    const result = await apiRequest("/api/admin/me");
    state.user = result.user || null;
    if (state.user && !state.user.mustChangePassword) await loadAdminData();
    render();
  } catch {
    render();
  }
}

init();
