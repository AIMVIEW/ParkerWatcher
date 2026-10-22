(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const c = window.PARKER_CONFIG;
  const parser = window.ParkingArray;
  let client = null, phase = 'idle', desiredConnection = false, generation = 0;
  let retryTimer = null, retries = 0, values = Array(c.initialSlots).fill(null);
  let receivedAt = null, verified = false, dataNote = 'รอผลตรวจจากรถสำรวจ';

  function fresh() {
    return phase === 'connected' && verified && receivedAt !== null && Date.now() - receivedAt <= c.staleAfterSeconds * 1000;
  }
  function drawSlots() {
    const nodes = values.map((value, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot ' + (value === 1 ? 'occupied' : value === 0 ? 'empty' : 'unknown');
      const id = c.slotPrefix + (index + 1), label = value === 1 ? 'มีรถจอด' : value === 0 ? 'ว่าง' : 'รอข้อมูล';
      slot.setAttribute('role', 'img');
      slot.setAttribute('aria-label', id + ' ' + label);
      const name = document.createElement('span'); name.className = 'slot-id'; name.textContent = id;
      const visual = document.createElement('span'); visual.className = 'slot-visual'; visual.setAttribute('aria-hidden', 'true');
      const symbol = document.createElement('span'); symbol.className = value === 1 ? 'car' : 'placeholder'; symbol.textContent = value === 1 ? '' : value === 0 ? '+' : '?';
      visual.append(symbol);
      const status = document.createElement('span'); status.className = 'slot-state'; status.textContent = label;
      slot.append(name, visual, status);
      return slot;
    });
    $('parkingSlots').replaceChildren(...nodes);
  }
  function render() {
    $('totalCount').textContent = values.length;
    $('availableCount').textContent = fresh() ? parser.countAvailable(values) : '—';
    document.querySelector('.lot').classList.toggle('stale', receivedAt !== null && !fresh());
    if (receivedAt !== null && verified && phase === 'connected') {
      $('dataStatus').textContent = fresh()
        ? 'รับข้อมูลล่าสุด ' + new Date(receivedAt).toLocaleTimeString('th-TH') + (values.includes(null) ? ' · บางช่องยังรอข้อมูล' : '')
        : 'ข้อมูลเก่า · รอผลตรวจรอบใหม่';
    } else $('dataStatus').textContent = dataNote;
    $('connectButton').classList.toggle('active', phase !== 'idle');
    $('connectButton').textContent = phase === 'idle' ? 'Connect ↗' : phase === 'connected' ? 'Disconnect' : 'Cancel';
  }
  function status(text, error) {
    $('connectionStatus').textContent = text;
    $('connectionStatus').classList.toggle('error', Boolean(error));
    render();
  }
  function disconnect() {
    desiredConnection = false; generation++; clearTimeout(retryTimer); retryTimer = null;
    const old = client; client = null; phase = 'idle'; verified = false;
    dataNote = receivedAt === null ? 'รอผลตรวจจากรถสำรวจ' : 'ไม่ได้เชื่อมต่อ · แสดงผลเดิมเพื่ออ้างอิง';
    if (old) { try { old.disconnect(); } catch (_) {} }
    status('ยังไม่ได้เชื่อมต่อ MQTT');
  }
  function failed(message, token, current) {
    if (token !== generation || client !== current) return;
    generation++; client = null; verified = false;
    try { current.disconnect(); } catch (_) {}
    dataNote = 'รอการเชื่อมต่อและผลตรวจใหม่';
    if (desiredConnection && c.autoReconnect) {
      phase = 'retry'; const wait = Math.min(30000, 2000 * Math.pow(2, retries++));
      status(message + ' · เชื่อมใหม่ใน ' + wait / 1000 + ' วินาที', true);
      retryTimer = setTimeout(() => { if (desiredConnection) openConnection(); }, wait);
    } else { phase = 'idle'; desiredConnection = false; status(message, true); }
  }
  function openConnection() {
    if (!desiredConnection) return;
    if (!window.Paho || !Paho.MQTT) { desiredConnection = false; phase = 'idle'; status('ไม่พบ vendor/mqttws31.js กรุณาแตก ZIP ให้ครบ', true); return; }
    if (location.protocol === 'https:' && !c.useSSL) { desiredConnection = false; phase = 'idle'; status('หน้า HTTPS ต้องใช้ WSS ตั้ง useSSL เป็น true', true); return; }
    phase = 'connecting'; status('กำลังเชื่อมต่อ MQTT…'); const token = ++generation;
    let current;
    try {
      const id = 'pw-web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      current = new Paho.MQTT.Client(c.host, c.port, c.path, id); client = current;
      current.onConnectionLost = () => failed('การเชื่อมต่อหลุด', token, current);
      current.onMessageArrived = message => {
        if (token !== generation || current !== client || message.destinationName !== c.topic) return;
        try {
          const next = parser.parseSnapshot(message.payloadString, c.maxSlots);
          values = next; receivedAt = Date.now(); verified = !message.retained;
          dataNote = message.retained ? 'ข้อมูลเดิมจาก Broker · รอผลตรวจใหม่ก่อนนับที่ว่าง' : 'ได้รับข้อมูลแล้ว';
          drawSlots(); status(message.retained ? 'เชื่อมต่อแล้ว · รอข้อความใหม่' : 'เชื่อมต่อ MQTT แล้ว');
        } catch (error) {
          // Preserve the last valid snapshot; never turn an invalid payload into vacancies.
          status('ข้อความไม่ถูกต้อง: ' + error.message, true);
        }
      };
      const options = {timeout:8, keepAliveInterval:30, cleanSession:true, mqttVersion:4, useSSL:c.useSSL,
        onSuccess:() => {
          if (token !== generation || client !== current) { try { current.disconnect(); } catch (_) {} return; }
          current.subscribe(c.topic, {qos:1, timeout:8,
            onSuccess:() => { if (token !== generation || client !== current) return; phase = 'connected'; retries = 0; status('เชื่อมต่อแล้ว · รอข้อมูลจากรถ'); },
            onFailure:() => failed('Subscribe ไม่สำเร็จ', token, current)
          });
        },
        onFailure:() => failed('เชื่อมต่อไม่ได้ ตรวจค่าใน config.js', token, current)
      };
      if (c.username) options.userName = c.username;
      current.connect(options);
    } catch (error) {
      if (current) failed('เริ่ม MQTT ไม่สำเร็จ: ' + error.message, token, current);
      else { phase = 'idle'; desiredConnection = false; status(error.message, true); }
    }
  }
  $('connectButton').addEventListener('click', () => {
    if (phase !== 'idle') { disconnect(); return; }
    desiredConnection = true; verified = false; retries = 0; dataNote = 'รอผลตรวจใหม่จากรถสำรวจ'; openConnection();
  });
  window.addEventListener('beforeunload', disconnect);
  drawSlots(); render(); setInterval(render, 1000);
})();
