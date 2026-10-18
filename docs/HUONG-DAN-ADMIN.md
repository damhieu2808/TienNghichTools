# Hướng dẫn admin – TN Tool

Tài liệu cho người quản lý tool: vào chế độ admin, tạo key cho người dùng, đóng gói và gửi extension.

## Tổng quan

| Ai | Nhập gì | Được dùng |
|---|---|---|
| Admin (bạn) | Mật khẩu trong `extension/admin.js` | Prod + Dev, tạo key |
| Người dùng | Key 10 ký tự, ví dụ `K7M2Q-XP9RT` | Chỉ Prod, tới khi key hết hạn |

- Hạn dùng nằm sẵn trong key, không cần server. **Hạn tính từ lúc admin tạo key**, không phải lúc người dùng nhập.
- Giờ để xét hạn lấy từ **server game** (khi tab game đang mở), nên người dùng chỉnh giờ máy không có tác dụng. Khi không mở game, tool dùng giờ máy nhưng không bao giờ lùi về trước mốc giờ lớn nhất đã thấy.
- Hết hạn: popup khóa ngay lần bấm kế tiếp, job định kỳ trong game tự tắt.

## Cài đặt lần đầu (máy admin)

1. Cài Node.js (bản LTS). Đã cài sẵn trên máy hiện tại; máy mới thì chạy `winget install OpenJS.NodeJS.LTS`.
2. Trong thư mục `TNTools`, chạy `npm install` để cài công cụ làm rối code.
3. Tạo file `extension/admin.js` (file này **không có trên GitHub**):
   ```js
   const ADMIN_PASSWORD = 'mat-khau-cua-ban';
   ```
4. Mở `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `TNTools/extension`.

## Vào chế độ admin

Mở popup TN Tool, nhập mật khẩu trong `admin.js` vào ô key, bấm **Kích hoạt**. Góc trên hiện chữ `admin` và có nút chuyển Prod/Dev.

Đổi mật khẩu: sửa chuỗi trong `admin.js` → nạp lại extension → nhập mật khẩu mới. Bấm **Thoát admin** (Dev → Quản lý key) để đăng xuất.

## Tạo key cho người dùng

1. Chuyển sang **Dev** → mở **Quản lý key**.
2. Nhập số ngày (`0` = vĩnh viễn) → **Tạo key**. Dòng bên dưới hiện ngày giờ hết hạn chính xác.
3. **Copy key** → gửi cho người dùng.

Mẹo:
- Tạo key **ngay trước khi gửi**, vì hạn đã bắt đầu tính từ lúc tạo.
- Mở tab game trước khi tạo key để hạn tính theo giờ server game.
- Key chỉ chứa hạn dùng, không có tên người dùng. Nếu cần nhớ key nào của ai, tự ghi lại.
- **Không thu hồi được** một key đã gửi trước khi nó hết hạn. Với người lạ, nên gửi key ngắn ngày rồi gia hạn bằng key mới.

## Đóng gói và gửi extension

Trong thư mục `TNTools`, chạy:

```
powershell -ExecutionPolicy Bypass -File .\pack.ps1
```

Kết quả:
- `dist\TNTool-<version>.zip`: file gửi cho người dùng.
- `dist\TNTool\`: bản đã đóng gói, dùng để tự thử trước khi gửi.

Script tự động:
- thay `admin.js` bằng bản rỗng (người nhận không vào được admin),
- dừng lại nếu thấy mật khẩu admin lọt vào bất kỳ file nào,
- làm rối code `tn.js`, `popup.js`, `license.js` (cấu hình trong `obfuscate.js`),
- kiểm tra cú pháp bản đã làm rối, có lỗi thì không tạo file zip.

**Thử trước khi gửi:** Load unpacked thư mục `dist\TNTool` (gỡ bản đang cài trước), nhập một key user, bấm thử vài nút trong game.

## Người dùng cài đặt

Gửi kèm hướng dẫn này cho người dùng:

1. Giải nén file zip ra một thư mục và **giữ nguyên thư mục đó** (xóa đi là mất extension).
2. Mở Chrome → `chrome://extensions` → bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked** → chọn thư mục vừa giải nén.
4. Vào game, mở TN Tool, dán key → **Kích hoạt**.

## Cập nhật phiên bản mới

1. Tăng `version` trong `extension/manifest.json` (ví dụ `0.1.0` → `0.1.1`).
2. Chạy lại `pack.ps1`, gửi file zip mới.
3. Người dùng giải nén **đè lên thư mục cũ**, rồi bấm nút tải lại của TN Tool ở `chrome://extensions`. Key đã nhập vẫn giữ nguyên.

## Các file liên quan

| File | Vai trò | Lên GitHub |
|---|---|---|
| `extension/admin.js` | Mật khẩu admin | Không (`.gitignore`) |
| `extension/license.js` | Kiểm tra và tạo key, chứa `LIC_SECRET` | Có |
| `pack.ps1` | Đóng gói | Có |
| `obfuscate.js` | Cấu hình làm rối code | Có |
| `dist/` | Bản đóng gói | Không |

## Giới hạn bảo mật

Tool chạy hoàn toàn trên máy người dùng nên chỉ chặn được người dùng bình thường:

- Code đã làm rối nhưng **không mã hóa được**. Người rành JavaScript chịu bỏ công vẫn gỡ ra, tìm `LIC_SECRET` để tự tạo key, hoặc sửa code để bỏ phần kiểm tra.
- Khi `tn.js` đã nạp vào game, các hàm trong đó gọi được từ console trình duyệt.
- **`LIC_SECRET` trong `license.js` là chìa khóa tạo key.** Repo hiện để private. Nếu chuyển repo sang public hoặc nghi bị lộ: đổi `LIC_SECRET` sang chuỗi ngẫu nhiên mới, đóng gói và gửi lại bản mới. Mọi key cũ sẽ hết dùng được, phải tạo key mới cho từng người.

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
|---|---|
| Nhập mật khẩu admin báo "Key không đúng" | Kiểm tra `extension/admin.js` có tồn tại và đúng chuỗi, rồi nạp lại extension. |
| `pack.ps1` báo chưa cài Node.js / javascript-obfuscator | Cài Node.js, chạy `npm install` trong thư mục `TNTools`. |
| `pack.ps1` báo mật khẩu admin xuất hiện trong file | Có file nào đó chứa mật khẩu; xóa chỗ đó khỏi code rồi chạy lại. |
| Người dùng báo key hết hạn sớm | Hạn tính từ lúc tạo key, không phải lúc nhập. Tạo key mới. |
| Chữ tiếng Việt trong `pack.ps1` bị lỗi font | File phải lưu dạng UTF-8 có BOM (PowerShell 5.1 cần BOM). |
