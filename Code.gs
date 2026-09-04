/**
 * Smart Store Manager — Backend (Google Apps Script)
 * ------------------------------------------------------------
 * วางไฟล์นี้ใน Apps Script Editor (Extensions > Apps Script) ของ
 * Google Sheet ที่ใช้เก็บข้อมูลสต๊อก แล้ว Deploy > New deployment
 * > Web app
 *   - Execute as: Me
 *   - Who has access: Anyone (หรือ Anyone with Google account ถ้าต้องการจำกัด)
 * แล้วคัดลอก URL ที่ลงท้ายด้วย /exec มาใส่ใน app.js (CONFIG.ENDPOINT_URL)
 *
 * โครงสร้างชีตที่ต้องมี (สร้างเองถ้ายังไม่มี):
 *   1) "Master"       คอลัมน์: Barcode | ItemName | Unit | ReorderPoint
 *   2) "Transactions"  คอลัมน์: Timestamp | Barcode | ItemName | Action | Qty | Location | Operator | Note
 *   3) "Stock"        คอลัมน์: Barcode | ItemName | Unit | Qty
 * ------------------------------------------------------------
 */

const SHEET_MASTER = "Master";
const SHEET_TRANSACTIONS = "Transactions";
const SHEET_STOCK = "Stock";

function doGet(e) {
  return jsonResponse({ status: "ok", message: "Smart Store Manager API is running" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // ป้องกันการเขียนชนกันเมื่อมีหลายเครื่องยิงเข้ามาพร้อมกัน (สำคัญมากสำหรับสต๊อก)
    lock.waitLock(15000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: "error", message: "ไม่พบข้อมูลที่ส่งมา" });
    }

    const payload = JSON.parse(e.postData.contents);
    const validationError = validatePayload(payload);
    if (validationError) {
      return jsonResponse({ status: "error", message: validationError });
    }

    const master = lookupMaster(payload.barcode);
    if (!master) {
      // ไม่พบใน master data — ยังบันทึก transaction ไว้เป็นหลักฐาน แต่แจ้งเตือนกลับไปให้ผู้ใช้ตรวจสอบ
      appendTransaction(payload, "(ไม่พบใน Master)");
      return jsonResponse({
        status: "warning",
        message: `ไม่พบรหัส ${payload.barcode} ใน Master data — บันทึกรายการไว้แล้ว แต่กรุณาตรวจสอบรหัสสินค้า`,
        itemName: null
      });
    }

    const stockResult = applyStockChange(payload, master);
    if (stockResult.error) {
      return jsonResponse({ status: "error", message: stockResult.error });
    }

    appendTransaction(payload, master.itemName);

    return jsonResponse({
      status: "success",
      itemName: master.itemName,
      stockAfter: stockResult.stockAfter,
      lowStock: master.reorderPoint != null && stockResult.stockAfter <= master.reorderPoint
    });

  } catch (err) {
    return jsonResponse({ status: "error", message: "เกิดข้อผิดพลาด: " + err.message });
  } finally {
    lock.releaseLock();
  }
}

function validatePayload(payload) {
  if (!payload.barcode) return "ไม่มีรหัสบาร์โค้ด";
  if (!payload.action || ["IN", "OUT", "AUDIT"].indexOf(payload.action) === -1) return "action ไม่ถูกต้อง";
  if (typeof payload.quantity !== "number" || payload.quantity <= 0) return "จำนวนต้องมากกว่า 0";
  return null;
}

function lookupMaster(barcode) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_MASTER);
  const data = sheet.getDataRange().getValues(); // [Barcode, ItemName, Unit, ReorderPoint]
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(barcode).trim()) {
      return {
        barcode: data[i][0],
        itemName: data[i][1],
        unit: data[i][2],
        reorderPoint: data[i][3] === "" ? null : Number(data[i][3])
      };
    }
  }
  return null;
}

/**
 * ปรับยอดคงเหลือใน Stock sheet ตามประเภทรายการ
 *   IN    -> บวกเข้า
 *   OUT   -> ลบออก (กันติดลบ — ถ้าเบิกเกินยอดคงเหลือจะ error กลับไป)
 *   AUDIT -> เซ็ตยอดให้ตรงกับที่นับได้จริง (ไม่บวก/ลบสะสม)
 */
function applyStockChange(payload, master) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_STOCK);
  const data = sheet.getDataRange().getValues(); // [Barcode, ItemName, Unit, Qty]
  let rowIndex = -1;
  let currentQty = 0;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(payload.barcode).trim()) {
      rowIndex = i + 1; // 1-indexed สำหรับ getRange
      currentQty = Number(data[i][3]) || 0;
      break;
    }
  }

  let newQty;
  if (payload.action === "IN") {
    newQty = currentQty + payload.quantity;
  } else if (payload.action === "OUT") {
    newQty = currentQty - payload.quantity;
    if (newQty < 0) {
      return { error: `ยอดคงเหลือไม่พอ (คงเหลือ ${currentQty} แต่เบิก ${payload.quantity})` };
    }
  } else {
    // AUDIT: ตั้งยอดใหม่ตามที่นับได้จริง
    newQty = payload.quantity;
  }

  if (rowIndex === -1) {
    sheet.appendRow([payload.barcode, master.itemName, master.unit, newQty]);
  } else {
    sheet.getRange(rowIndex, 4).setValue(newQty);
  }

  return { stockAfter: newQty };
}

function appendTransaction(payload, itemName) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_TRANSACTIONS);
  sheet.appendRow([
    payload.timestamp || new Date().toISOString(),
    payload.barcode,
    itemName || "",
    payload.action,
    payload.quantity,
    payload.location || "",
    payload.userId || "",
    payload.id || ""
  ]);
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
