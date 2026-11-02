# TREE CHARGE · OCPP 1.6J server

ตู้ชาร์จจริง ⇄ เซิร์ฟเวอร์นี้ (VPS) ⇄ แอป TREE CHARGE (Google Apps Script)

- ตู้ต่อเข้ามาที่ `ws://<IP>:9000/ocpp/<ChargePointID>`
- เซิร์ฟเวอร์ส่งสถานะ / kWh / kW / % แบต ไปที่แอป และรับคำสั่งเริ่ม–หยุดชาร์จจากแอป

## ติดตั้งบน VPS (Ubuntu 24.04)

```
git clone https://github.com/<ชื่อคุณ>/treecharge-ocpp
cd treecharge-ocpp
sudo bash install.sh
```

ตอนติดตั้ง ระบบจะถาม 2 อย่าง: ลิงก์ /exec ของ Apps Script และ hookKey (จาก Google Sheet แท็บ Config)
จบแล้วจะแสดงค่า `OCPP_URL` และ `OCPP_KEY` ให้นำไปใส่ใน Apps Script → Project Settings → Script Properties

## ทดสอบด้วยตู้จำลอง (ไม่ต้องมีตู้จริง)

```
node /opt/treecharge-ocpp/tools/sim.js ws://127.0.0.1:9000/ocpp/TCTEST01 120 2 10
```

## คำสั่งที่ใช้บ่อย

| ทำอะไร | คำสั่ง |
|---|---|
| ดู log สด | `journalctl -u treecharge-ocpp -f` |
| รีสตาร์ท | `systemctl restart treecharge-ocpp` |
| ดูตู้ที่ต่ออยู่ | `curl -H "Authorization: Bearer <OCPP_KEY>" http://127.0.0.1:9000/chargers` |
| อัปเดตโค้ด | `cd treecharge-ocpp && git pull && sudo bash install.sh` |

ห้ามส่ง OCPP_KEY, hookKey หรือรหัสผ่าน VPS ในแชท
