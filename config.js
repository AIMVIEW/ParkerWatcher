// แก้การเชื่อมต่อที่นี่ หน้าเว็บไม่ต้องติดตั้ง Node.js และไม่โหลดจาก CDN
window.PARKER_CONFIG = Object.freeze({
  host: 'mqtt-dashboard.com',
  port: 8884,             // WebSocket port; Arduino ใช้ TCP 1883 ของ Broker เดียวกัน
  path: '/mqtt',
  useSSL: true,          // WSS
  topic: 'parkerwatcher/lot01/slots', // Topic เดียวสำหรับสถานะทั้งลาน
  username: '',
  // เว็บ static เปิดเผยไฟล์ได้ อย่า commit password ของบัญชีส่วนตัวใน repository
  initialSlots: 4,        // จำนวนช่องที่แสดงระหว่างรอข้อความแรก
  slotPrefix: 'A',        // array[0] -> A1, array[1] -> A2, ...
  maxSlots: 200,          // ป้องกันข้อความผิดพลาดสร้างกล่องจำนวนมาก
  staleAfterSeconds: 180, // ปรับให้มากกว่าเวลาวิ่งหนึ่งรอบรวมเวลาพัก
  autoReconnect: true
});
