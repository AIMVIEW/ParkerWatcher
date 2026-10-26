#include <WiFiS3.h>
#include <MQTT.h>

// --- Wi-Fi ---
const char WIFI_SSID[] = "sirin";
const char WIFI_PASSWORD[] = "YOUR_WIFI_PASSWORD";

// --- MQTT ---
const char MQTT_HOST[] = "mqtt-dashboard.com";
const int MQTT_PORT = 1883;
const char SLOTS_TOPIC[] = "parkerwatcher/lot01/slots";

WiFiClient network;
MQTTClient mqtt(256);

char clientId[32];

const unsigned long WIFI_RETRY_MS = 10000;
const unsigned long MQTT_RETRY_MS = 5000;
const unsigned long PUBLISH_RETRY_MS = 1000;

unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;
unsigned long lastPublishAttempt = 0;

bool needsPublish = false;

// --- ขามอเตอร์ L298N ---
const int IN1 = 3;  // PWM มอเตอร์ซ้าย
const int IN2 = 2;
const int IN3 = 5;  // PWM มอเตอร์ขวา
const int IN4 = 4;

const int MOTOR_SPEED = 200;

// --- การหมุนกลับ ---
const unsigned long TURN_TIME_MS = 1100;
const unsigned long AFTER_TURN_STOP_MS = 500;

// --- เซนเซอร์ IR ---
const int SENSOR_LEFT = A0;
const int SENSOR_RIGHT = A1;
const int THRESHOLD = 340;

// --- Ultrasonic HC-SR04 ---
const int TRIG_PIN = 8;
const int ECHO_PIN = 9;
const float PARKING_LIMIT_CM = 20.0;

// --- สถานะสามช่อง ---
// -1 = ยังไม่ทราบ, 0 = ว่าง, 1 = มีรถ
const int SLOT_COUNT = 3;
int parking[SLOT_COUNT] = {-1, -1, -1};

// --- การนับจุด ---
// 1–3: ตรวจ Ultrasonic และส่ง MQTT
// 4–6: ไม่ตรวจและไม่ส่งข้อมูล
int count = 0;

bool onBlackMarker = false;
bool checkingClear = false;
unsigned long clearStartedAt = 0;

// พ้นดำคู่ต่อเนื่อง 100 ms จึงพร้อมนับใหม่
const unsigned long CLEAR_TIME_MS = 100;

// หยุดพักที่จุด 1, 2, 4, 5
const unsigned long STOP_TIME_MS = 3000;

// รอรถนิ่งก่อนวัด Ultrasonic
const unsigned long SETTLE_TIME_MS = 100;

bool waitingAtMarker = false;
unsigned long stopStartedAt = 0;

// --- ประกาศฟังก์ชัน ---
void serviceMQTTWhileStopped();
bool publishParking();
float getDistance();

void moveForward();
void turnLeft();
void turnRight();
void stopCar();
void turnAround180();

// ==================================================
// Setup
// ==================================================
void setup() {
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  analogWriteResolution(8);
  analogReadResolution(10);

  stopCar();

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  Serial.begin(9600);
  delay(1000);

  mqtt.begin(MQTT_HOST, MQTT_PORT, network);
  mqtt.setTimeout(1000);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttempt = millis();

  byte mac[6];
  WiFi.macAddress(mac);

  snprintf(
    clientId,
    sizeof(clientId),
    "pw-car-%02X%02X%02X%02X%02X%02X",
    static_cast<unsigned int>(mac[0]),
    static_cast<unsigned int>(mac[1]),
    static_cast<unsigned int>(mac[2]),
    static_cast<unsigned int>(mac[3]),
    static_cast<unsigned int>(mac[4]),
    static_cast<unsigned int>(mac[5])
  );

  lastMqttAttempt = millis() - MQTT_RETRY_MS;
  lastPublishAttempt = millis() - PUBLISH_RETRY_MS;
}

// ==================================================
// Loop
// ==================================================
void loop() {
  // ดูแล connection เดิม โดยไม่ส่งผลตรวจใหม่จากส่วนนี้
  if (WiFi.status() == WL_CONNECTED && mqtt.connected()) {
    mqtt.loop();
  }

  // --- หยุดพักที่จุด 1, 2, 4, 5 ---
  if (waitingAtMarker) {
    stopCar();

    // เชื่อมต่อและส่งผลเฉพาะช่วงตรวจ 1–3
    if (count >= 1 && count <= SLOT_COUNT) {
      serviceMQTTWhileStopped();
    }

    if (millis() - stopStartedAt < STOP_TIME_MS) {
      return;
    }

    waitingAtMarker = false;
  }

  int leftVal = analogRead(SENSOR_LEFT);
  int rightVal = analogRead(SENSOR_RIGHT);

  bool leftIsBlack = (leftVal > THRESHOLD);
  bool rightIsBlack = (rightVal > THRESHOLD);

  // --- พบดำทั้งสองข้าง ---
  if (leftIsBlack && rightIsBlack) {
    checkingClear = false;

    // นับเฉพาะตอนเข้าจุดใหม่
    if (!onBlackMarker) {
      onBlackMarker = true;
      count++;

      stopCar();
      stopStartedAt = millis();

      Serial.print("Count: ");
      Serial.println(count);

      // --- Count 1–3: ตรวจ Ultrasonic ---
      if (count <= SLOT_COUNT) {
        // เริ่มรอบใหม่: ล้างผลช่องที่ยังไม่ได้ตรวจ
        if (count == 1) {
          for (int i = 0; i < SLOT_COUNT; i++) {
            parking[i] = -1;
          }
        }

        delay(SETTLE_TIME_MS);
        float distance = getDistance();

        int slotIndex = count - 1;

        if (distance < 0) {
          parking[slotIndex] = -1;
        }
        else if (distance <= PARKING_LIMIT_CM) {
          parking[slotIndex] = 1;
        }
        else {
          parking[slotIndex] = 0;
        }

        Serial.print("ตรวจ A");
        Serial.print(count);
        Serial.print(" ระยะ: ");

        if (distance < 0) {
          Serial.println("อ่านระยะไม่ได้");
        }
        else {
          Serial.print(distance, 1);
          Serial.println(" cm");
        }

        needsPublish = true;
        lastPublishAttempt = millis() - PUBLISH_RETRY_MS;

        // พยายามส่งผลขณะรถหยุด ก่อนหมุนหรือเดินต่อ
        serviceMQTTWhileStopped();
      }

      // --- Count 3: หมุนกลับแล้วเดินต่อ ---
      if (count == SLOT_COUNT) {
        Serial.println("ครบ 3 จุด กำลังหมุนกลับ");

        turnAround180();

        // ล็อกจุดเดิมไว้ ป้องกันนับซ้ำหลังหมุน
        onBlackMarker = true;
        checkingClear = false;

        Serial.println("เริ่มขากลับ: นับจุด 4–6");
      }

      // --- Count 6: หมุนกลับแล้วรีเซ็ต count ---
      else if (count >= SLOT_COUNT * 2) {
        Serial.println("ครบ 6 จุด กำลังหมุนกลับ");

        turnAround180();

        count = 0;
        waitingAtMarker = false;

        // ต้องพ้นจุดเดิมก่อนนับครั้งที่ 1 ของรอบใหม่
        onBlackMarker = true;
        checkingClear = false;

        Serial.println("เริ่มนับรอบใหม่");
      }

      // --- Count 1, 2, 4, 5: หยุดพัก ---
      else {
        waitingAtMarker = true;
      }

      return;
    }

    // ยังอยู่บนจุดเดิม: เดินหน้าข้ามโดยไม่นับซ้ำ
    moveForward();
    return;
  }

  // --- พ้นดำคู่ต่อเนื่องก่อนอนุญาตให้นับใหม่ ---
  if (onBlackMarker) {
    if (!checkingClear) {
      checkingClear = true;
      clearStartedAt = millis();
    }

    if (millis() - clearStartedAt >= CLEAR_TIME_MS) {
      onBlackMarker = false;
      checkingClear = false;
    }
  }

  // --- เดินตามเส้นเหมือนเดิม ---
  if (!leftIsBlack && !rightIsBlack) {
    moveForward();
  }
  else if (leftIsBlack && !rightIsBlack) {
    turnRight();
  }
  else if (!leftIsBlack && rightIsBlack) {
    turnLeft();
  }
}

// ==================================================
// เชื่อมต่อและส่งผลเฉพาะตอนหยุดในช่วง Count 1–3
// ==================================================
void serviceMQTTWhileStopped() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttempt >= WIFI_RETRY_MS) {
      lastWifiAttempt = now;
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }

  if (!mqtt.connected()) {
    if (now - lastMqttAttempt >= MQTT_RETRY_MS) {
      lastMqttAttempt = now;
      mqtt.connect(clientId);
    }
  }

  if (!mqtt.connected()) {
    return;
  }

  mqtt.loop();

  if (needsPublish &&
      mqtt.connected() &&
      millis() - lastPublishAttempt >= PUBLISH_RETRY_MS) {
    lastPublishAttempt = millis();

    if (publishParking()) {
      needsPublish = false;
    }
  }
}

// ==================================================
// ส่งสถานะครบสามช่อง
// ==================================================
bool publishParking() {
  String payload = "[";

  for (int i = 0; i < SLOT_COUNT; i++) {
    if (i > 0) {
      payload += ",";
    }

    if (parking[i] == -1) {
      payload += "null";
    }
    else {
      payload += String(parking[i]);
    }
  }

  payload += "]";

  // retain=false, QoS=1
  bool sent = mqtt.publish(
    SLOTS_TOPIC,
    payload,
    false,
    1
  );

  Serial.print(sent ? "ส่งสำเร็จ: " : "ส่งไม่สำเร็จ: ");
  Serial.println(payload);

  return sent;
}

// ==================================================
// วัดระยะ HC-SR04
// คืน -1 เมื่อไม่ได้รับ echo
// ==================================================
float getDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration =
      pulseIn(ECHO_PIN, HIGH, 30000UL);

  if (duration == 0) {
    return -1;
  }

  return duration * 0.0343f / 2.0f;
}

// ==================================================
// ควบคุมมอเตอร์
// ==================================================
void moveForward() {
  digitalWrite(IN2, LOW);
  digitalWrite(IN4, LOW);

  analogWrite(IN1, MOTOR_SPEED);
  analogWrite(IN3, MOTOR_SPEED);
}

void turnLeft() {
  analogWrite(IN1, 0);
  digitalWrite(IN2, LOW);

  digitalWrite(IN4, LOW);
  analogWrite(IN3, MOTOR_SPEED);
}

void turnRight() {
  analogWrite(IN3, 0);
  digitalWrite(IN4, LOW);

  digitalWrite(IN2, LOW);
  analogWrite(IN1, MOTOR_SPEED);
}

void stopCar() {
  analogWrite(IN1, 0);
  digitalWrite(IN2, LOW);

  analogWrite(IN3, 0);
  digitalWrite(IN4, LOW);
}

// --- หมุนกลับประมาณ 180 องศา ---
void turnAround180() {
  stopCar();
  delay(10);

  // ล้อซ้ายเดินหน้า
  digitalWrite(IN2, LOW);
  analogWrite(IN1, MOTOR_SPEED);

  // ล้อขวาถอยหลัง
  digitalWrite(IN4, HIGH);
  analogWrite(IN3, 255 - MOTOR_SPEED);

  delay(TURN_TIME_MS);

  // หยุดนิ่งหลังหมุน ก่อนกลับไปอ่านเส้น
  stopCar();
  delay(AFTER_TURN_STOP_MS);
}
