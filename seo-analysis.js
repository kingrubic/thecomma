const words = (value = "") => String(value).toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9đ]+/gi) || [];
const plain = (value = "") => String(value).replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const count = (value = "") => words(plain(value)).length;
const has = (value, term) => term && plain(value).toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(term);

function rule(id, severity, title, detail, suggestion) { return { id, severity, title, detail, suggestion, weight: 1 }; }

export function analyzeSeo(post = {}, site = "thecomma") {
  const title = String(post.title || "").trim();
  const slug = String(post.slug || "").trim();
  const excerpt = String(post.excerpt || "").trim();
  const content = String(post.content || "");
  const tagList = Array.isArray(post.tags) ? post.tags : String(post.tags || "").split(",").map((tag) => tag.trim()).filter(Boolean);
  const keyword = String(post.focusKeyword || tagList[0] || "").trim();
  const normalizedKeyword = words(keyword).join(" ");
  const text = plain(content);
  const wordCount = count(content);
  const sentences = text.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean);
  const paragraphs = content.split(/\n\s*\n/).map((item) => plain(item)).filter(Boolean);
  const headings = (content.match(/^\s{0,3}#{1,6}\s+.+$/gm) || []).length;
  const images = [...content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)];
  const links = (content.match(/(?<!!)(?:\[[^\]]+\]\([^)]*\)|https?:\/\/\S+)/g) || []).length;
  const issues = [];
  const add = (id, good, titleText, detail, suggestion) => issues.push(rule(id, good ? "good" : "warning", titleText, detail, suggestion));
  const addError = (id, titleText, detail, suggestion) => issues.push(rule(id, "error", titleText, detail, suggestion));

  if (title.length >= 35 && title.length <= 70) add("title", true, "Tiêu đề đang tốt", `${title.length} ký tự.`, "Giữ tiêu đề rõ lợi ích và đúng trọng tâm.");
  else if (title.length >= 25 && title.length <= 85) add("title", false, "Tiêu đề có thể tối ưu", `${title.length} ký tự.`, "Đưa tiêu đề về khoảng 35–70 ký tự.");
  else addError("title", "Tiêu đề cần chỉnh", `${title.length} ký tự.`, "Viết tiêu đề rõ ý chính, khoảng 35–70 ký tự.");
  if (excerpt.length >= 90 && excerpt.length <= 160) add("excerpt", true, "Mô tả SEO tốt", `${excerpt.length} ký tự.`, "Giữ lợi ích chính ở ngay đầu mô tả.");
  else if (excerpt.length >= 60 && excerpt.length <= 180) add("excerpt", false, "Mô tả cần cân lại", `${excerpt.length} ký tự.`, "Nên viết mô tả khoảng 90–160 ký tự.");
  else addError("excerpt", "Thiếu mô tả SEO tốt", `${excerpt.length} ký tự.`, "Thêm mô tả 1–2 câu, khoảng 90–160 ký tự.");
  const slugParts = slug.split("-").filter(Boolean);
  if (slugParts.length >= 3 && slugParts.length <= 8) add("slug", true, "Slug gọn", `${slugParts.length} cụm từ.`, "Giữ slug ngắn, dễ đọc và không đổi sau khi xuất bản.");
  else add("slug", false, "Slug cần tối ưu", `${slugParts.length} cụm từ.`, "Dùng chữ thường, dấu gạch ngang và 3–8 cụm từ.");
  if (normalizedKeyword) {
    const keywordHits = [title, slug, excerpt, content].filter((value) => has(value, normalizedKeyword)).length;
    if (keywordHits >= 3) add("keyword", true, "Từ khóa chính đã có ngữ cảnh", `“${keyword}” xuất hiện ở ${keywordHits}/4 vị trí chính.`, "Giữ cách dùng tự nhiên, không lặp gượng ép.");
    else add("keyword", false, "Từ khóa chính còn mờ", `“${keyword}” mới xuất hiện ở ${keywordHits}/4 vị trí chính.`, "Đưa từ khóa tự nhiên vào tiêu đề, mô tả, slug hoặc đoạn mở đầu.");
  } else add("keyword", false, "Chưa có từ khóa chính", "Trợ lý chưa có keyword để đối chiếu.", "Nhập một cụm từ người đọc thật sự sẽ tìm kiếm.");
  if (wordCount >= 700) add("length", true, "Nội dung đủ chiều sâu", `${wordCount} từ.`, "Độ dài phù hợp cho một bài SEO chính.");
  else if (wordCount >= 350) add("length", false, "Nội dung hơi mỏng", `${wordCount} từ.`, "Có thể thêm ví dụ, hướng dẫn hoặc phần kết luận.");
  else addError("length", "Nội dung quá ngắn", `${wordCount} từ.`, "Nên mở rộng ít nhất 350–700 từ nếu đây là bài SEO chính.");
  if ((wordCount < 300 && headings >= 1) || (wordCount >= 300 && headings >= Math.max(2, Math.floor(wordCount / 350)))) add("headings", true, "Cấu trúc heading tốt", `${headings} heading.`, "Giữ heading giúp người đọc scan nhanh.");
  else add("headings", false, "Thiếu heading phụ", `${headings} heading cho ${wordCount} từ.`, "Thêm H2/H3 sau mỗi 250–400 từ.");
  const missingAlt = images.filter((match) => !String(match[1] || "").trim()).length;
  if (post.coverImage && missingAlt === 0) add("images", true, "Hình ảnh ổn", `${images.length + 1} ảnh, có cover.`, "Giữ alt text mô tả đúng nội dung ảnh.");
  else if (post.coverImage || images.length) add("images", false, "Ảnh cần mô tả tốt hơn", missingAlt ? `${missingAlt} ảnh thiếu alt.` : "Bài chưa có cover.", "Thêm cover và alt text rõ nghĩa cho ảnh nội dung.");
  else addError("images", "Thiếu hình ảnh", "Chưa có cover hoặc ảnh nội dung.", "Thêm cover phù hợp để tăng khả năng hiển thị và chia sẻ.");
  if ((wordCount < 250 && links > 0) || (wordCount >= 250 && links >= 2)) add("links", true, "Liên kết hữu ích", `${links} liên kết.`, "Kết hợp internal link với nguồn tham khảo uy tín.");
  else add("links", false, "Cần thêm liên kết", `${links} liên kết.`, "Thêm link đến bài/trang liên quan để tăng ngữ cảnh.");
  if (tagList.length >= 2 && tagList.length <= 6) add("tags", true, "Thẻ nội dung rõ", `${tagList.length} thẻ.`, "Giữ thẻ cụ thể, tránh lặp từ khóa quá mức.");
  else add("tags", false, "Thẻ nội dung chưa đủ", `${tagList.length} thẻ.`, "Thêm 2–6 thẻ liên quan trực tiếp đến bài.");
  const brandTerms = site === "vaniet" ? ["tp hcm", "tphcm", "ho chi minh", "giay", "tui", "da", "phuc hoi"] : ["ca phe", "tra", "matcha", "do uong", "mon theo mua"];
  if (brandTerms.some((term) => has(`${title} ${excerpt} ${content} ${slug}`, term))) add("intent", true, "Đúng ngữ cảnh thương hiệu", site === "vaniet" ? "Có tín hiệu dịch vụ/phục hồi hoặc địa phương." : "Có tín hiệu đồ uống và trải nghiệm The Comma.", "Tiếp tục giữ ngôn ngữ tự nhiên, đúng sản phẩm.");
  else add("intent", false, "Ngữ cảnh thương hiệu còn yếu", "Chưa thấy tín hiệu chủ đề chính của website.", site === "vaniet" ? "Nêu rõ dịch vụ, chất liệu hoặc khu vực phục vụ nếu phù hợp." : "Nêu rõ loại đồ uống, nguyên liệu hoặc trải nghiệm được kể.");

  const goodCount = issues.filter((issue) => issue.severity === "good").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const earned = issues.reduce((sum, issue) => sum + (issue.severity === "good" ? 1 : issue.severity === "warning" ? .55 : 0), 0);
  const score = Math.round((earned / issues.length) * 100);
  const signal = score >= 71 ? "good" : score >= 41 ? "ok" : "bad";
  return { score, signal, label: signal === "good" ? "Tốt" : signal === "ok" ? "Cần cải thiện" : "Cần sửa", issues, goodCount, warningCount, errorCount, stats: { wordCount, sentenceCount: sentences.length, headingCount: headings, imageCount: images.length + (post.coverImage ? 1 : 0), linkCount: links } };
}
