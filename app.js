/**
 * Smart Store Manager — Frontend connector
 * ------------------------------------------------------------
 * เชื่อม smart-store-manager.html เข้ากับ Google Apps Script Web App
 * ต้อง implement processScanData(payload) ที่ return Promise:
 *   - resolve()  เมื่อบันทึกสำเร็จ  -> ระบบจะแสดง toast สำเร็จ
 *   - reject(err) เมื่อบันทึกไม่สำเร็จ/เน็ตหลุด -> ระบบจะเก็บเข้าคิวออฟไลน์ให้อัตโนมัติ
 * ------------------------------------------------------------
 */

const CONFIG = {
  ENDPOINT_URL: "https://script.google.com/macros/s/AKfycby_0bojUcnwux0jGp8JmekEIUAomwCbVthQYjCkuDfRTsPUMqnM3d7_ky278iNgcBrAJg/exec",
  TIMEOUT_MS: 12000
};

/**
 * เรียกจาก smart-store-manager.html ทุกครั้งที่มีการบันทึกรายการ (ทั้งสแกนสดและซิงค์คิวค้าง)
 */
async function processScanData(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.TIMEOUT_MS);

  let response;
  try {
    response = await fetch(CONFIG.ENDPOINT_URL, {
      method: "POST",
      // ใช้ text/plain แทน application/json เพื่อเลี่ยง CORS preflight (OPTIONS)
      // ซึ่ง Google Apps Script Web App ไม่รองรับ preflight request โดยตรง
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (networkErr) {
    clearTimeout(timer);
    // เน็ตหลุด/timeout/DNS ล้มเหลว -> โยน error ให้หน้า UI เก็บเข้าคิวออฟไลน์
    throw new Error("network-error: " + networkErr.message);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error("http-error: " + response.status);
  }

  let result;
  try {
    result = await response.json();
  } catch (parseErr) {
    throw new Error("invalid-response");
  }

  if (result.status === "error") {
    // ข้อผิดพลาดจาก business logic (เช่น สต๊อกไม่พอ) — ไม่ควรเข้าคิวออฟไลน์ซ้ำ เพราะจะ error ซ้ำเรื่อย ๆ
    // แจ้งผู้ใช้ตรงนี้แล้วโยน error พิเศษที่ UI แยกแยะได้ว่าไม่ต้อง retry
    const err = new Error(result.message || "บันทึกไม่สำเร็จ");
    err.isBusinessError = true;
    throw err;
  }

  if (result.status === "warning") {
    // เช่น ไม่พบใน master data — บันทึกแล้วแต่ต้องเตือนผู้ใช้
    if (window.showToast) window.showToast(result.message, "warning");
    return result;
  }

  if (result.lowStock && window.showToast) {
    window.showToast(`⚠️ สต๊อก ${payload.barcode} ใกล้หมด (คงเหลือ ${result.stockAfter})`, "warning");
  }

  return result; // resolve ปกติ = บันทึกสำเร็จ
}
