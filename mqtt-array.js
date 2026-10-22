/* MQTT contract: one complete JSON array on one topic. No browser dependencies. */
(function(root) {
  'use strict';
  function parseSnapshot(payload, maxSlots) {
    maxSlots = maxSlots === undefined ? 200 : maxSlots;
    if (typeof payload !== 'string' || payload.length > 16384) throw new Error('Payload ต้องเป็นข้อความไม่เกิน 16 KB');
    let values;
    try { values = JSON.parse(payload); } catch (_) { throw new Error('ส่ง JSON array เช่น [1,0,1,0]'); }
    if (!Array.isArray(values) || values.length === 0 || values.length > maxSlots) throw new Error('ต้องเป็น array ที่มี 1–' + maxSlots + ' ช่อง');
    if (!values.every(value => value === 0 || value === 1 || value === null)) throw new Error('แต่ละช่องใช้ 0 = ว่าง, 1 = มีรถ หรือ null = ยังไม่ทราบเท่านั้น');
    return values;
  }
  function countAvailable(values) { return values.filter(value => value === 0).length; }
  const api = {parseSnapshot, countAvailable};
  root.ParkingArray = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
