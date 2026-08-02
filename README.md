# The Comma Coffee — website concept

Website được phát triển từ template Wandau do anh cung cấp, sau đó tái cấu trúc theo nhận diện thật của The Comma.

> Bản ZIP gốc không kèm certificate hoặc file license. Trước khi xuất bản thương mại, cần đối chiếu loại license Wandau trên tài khoản/marketplace đã mua template.

## Xem website

Nhấp đúp `start.command`, hoặc chạy:

```bash
cd /Users/apple/Projects/cuong-coffee-website/site
python3 -m http.server 8765
```

Mở: http://127.0.0.1:8765

## Nội dung hiện có

- Hero nghệ thuật 3 cảnh
- Câu chuyện thương hiệu dựa trên tagline và bio chính thức
- 3 món gợi ý: An-Giang, Tây-Bắc, “Tào Phớ”
- Menu HTML 43 món với bộ lọc Coffee / Tea / Matcha / Season / Juice; nhóm Season hiện có Trà Quýt và Trà Sấu Mắc Khén
- Khu vực Single Origin / Hand Brew
- Khu vực trải nghiệm không gian: bàn dài, góc cửa sổ, hiên xanh và gửi xe miễn phí; có dẫn nguồn bài Facebook chính thức đăng lại
- Gallery 4 ảnh không gian thật từ Facebook chính thức: hai góc ngồi sáng, chi tiết nội thất và khu hiên cây xanh; ảnh quầy tối được giữ làm tư liệu nhưng không còn hiển thị
- Link PDF gốc dùng để đối chiếu; không trưng ảnh menu cũ trên homepage vì menu hiện hành đã có nhóm Season và các điều chỉnh trực tiếp từ thương hiệu
- Địa chỉ, giờ mở cửa, email, Instagram, Facebook và nút chỉ đường
- CTA GrabFood được ẩn hoàn toàn cho đến khi xác minh được URL merchant listing chính xác; không dùng URL tìm kiếm chung hoặc slug phỏng đoán
- Tạp chí nguyên liệu gồm 20 bài HTML tĩnh có metadata, `BlogPosting`, `FAQPage` và liên kết nội bộ; hai bài Season được ưu tiên đầu danh sách
- Responsive navigation panel

## Font

- Arsenal — font menu gốc, hỗ trợ tiếng Việt
- Noto Serif Display — tiêu đề nghệ thuật, hỗ trợ tiếng Việt

## Thông tin xác minh

Xem `/Users/apple/Projects/cuong-coffee-website/research/SOURCES.md`.

## Lưu ý hình ảnh

Bộ ảnh hero là art-direction concept, không phải ảnh chụp không gian thật của quán. Gallery `images/social/` sử dụng ảnh thật từ kênh chính thức và có nguồn trong `RESEARCH-SOURCES.md`.

Bộ art-direction chính hiện có:

- `images/comma-hero.png`
- `images/comma-soil.png`
- `images/comma-drinks.png`
- `images/comma-selected.jpg` — art-direction riêng cho An-Giang, Tây-Bắc và “Tào Phớ”
- `images/stories/` — 12 ảnh art-direction theo Season, cà phê, trà và matcha; hai món Season có crop riêng

## Cấu trúc chính

- `index.html` — nội dung trang
- `css/comma.css` — toàn bộ hệ mỹ thuật và responsive
- `js/comma.js` — slider, menu filter, panel điều hướng, dữ liệu 43 món
- `stories/index.html` — trang tổng hợp 20 bài
- `stories/<slug>/index.html` — từng bài SEO tĩnh
- `css/stories.css` — giao diện tạp chí và bài viết
- `assets/the-comma-menu.pdf` — menu PDF gốc
- `images/the-comma-logo.png` — logo trích từ menu
