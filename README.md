# TN Tool

Extension Chrome tự động làm nhiệm vụ ngày, sự kiện và một số việc lặp lại trong game **Tiên Nghịch** (bản web `tiennghich.joyplay.vn`, `tiennghich.acejoygame.com`).

Tool **miễn phí**, không cần key, mã nguồn mở theo giấy phép [MIT](LICENSE).

## Tính năng

| Nhóm | Nội dung |
|---|---|
| Hàng ngày 1 lần | Làm tất cả bằng một nút: tặng tình bạn, cung phụng, viện trợ, chiêu mộ, Đấu Tiên Đài, Thủ Vệ Tứ Phái, Bí Cảnh, PB ngày, Thông Thiên Tháp, tháp phái, tác chiến nhanh, Kiếm Hành, Bách Phạt Tông, Vực U Minh, Ảo cảnh trận pháp, Cổ Thần Địa... và nhận thưởng nhiệm vụ |
| Hàng ngày nhiều lần | Linh thú, Di tích, Cực Âm Địa, Núi cấm, Treo Thưởng |
| Spam | Leo tháp, Đấu Tiên Đài, Phó bản ngày theo số lần chọn |
| Event | Tự kiểm tra sự kiện nào đang mở rồi làm: Kim Thu Thập Quang, Uy Chấn Ý Vũ, Hỏa Thụ Ngân Hoa, Vòng quay may mắn, Cứu Uyển Nhi, Tỉ thí tông môn... |
| Job định kỳ | Cứ N phút tự chạy các việc lặp lại, kể cả khi đóng popup (cần giữ tab game mở) |
| Pháp bảo | Gợi ý / tự lắp pháp bảo tối ưu, thử nghiệm nhiều phương án, khôi phục cấu hình cũ |

## Cài đặt

1. Tải bản mới nhất ở mục [Releases](https://github.com/damhieu2808/TNTools/releases) (file `TNTool-<version>.zip`), hoặc tải mã nguồn và dùng thư mục `extension/`.
2. Giải nén ra một thư mục và **giữ nguyên thư mục đó** (xóa đi là mất extension).
3. Mở Chrome → `chrome://extensions` → bật **Developer mode** (góc trên bên phải).
4. Bấm **Load unpacked** → chọn thư mục vừa giải nén.

Cập nhật bản mới: giải nén đè lên thư mục cũ, rồi bấm nút tải lại của TN Tool ở `chrome://extensions`.

## Sử dụng

1. Vào game trên Chrome, đăng nhập nhân vật.
2. Bấm biểu tượng TN Tool trên thanh công cụ, chọn nút cần chạy.
3. Kết quả và tiến trình hiện ở khung log cuối popup. Bấm **Dừng** để ngắt việc đang chạy.

Chế độ **Dev** (góc trên popup) hiện thêm công cụ ghi lại gói tin khi bạn làm tay trong game và ô chạy code, dùng để tìm hiểu và thêm tính năng mới.

## Phát triển

- `extension/tn.js`: toàn bộ logic, được nạp vào trang game và gọi qua `window.TN`.
- `extension/popup.html`, `extension/popup.js`: giao diện popup.
- Sửa code xong chỉ cần bấm tải lại extension ở `chrome://extensions`.

Đóng gói file zip để phát hành:

```
powershell -ExecutionPolicy Bypass -File .\pack.ps1
```

Kết quả ở `dist\TNTool-<version>.zip`. Nhớ tăng `version` trong `extension/manifest.json` trước mỗi lần phát hành.

## Lưu ý

Đây là tool cá nhân, không liên quan tới nhà phát hành game. Dùng tool tự động có thể vi phạm điều khoản của game; bạn tự chịu trách nhiệm khi sử dụng.

## Giấy phép

[MIT](LICENSE) © 2026 hieu.dx
