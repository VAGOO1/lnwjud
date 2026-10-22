# VaGoo owned native fixture — R2

เครื่องมือสำหรับนักพัฒนาเพื่อตรวจตัวเปิดและการอ่านโปรเซสจำลองที่สร้างเองบน VaGoo แยกจากตัวเปิด process ของแอป ไม่มีการเรียก Shop/5090 หรือกู้ทะเบียนงานเก่า

## ตรวจจำลองจากโครงการ

```text
node --run=test:vagoo-fixture:mock
```

ใช้ Node 24 ตาม engines ของโครงการ โดย `--run` อ่าน package script โดยตรง ไม่ต้องติดตั้ง package manager เพิ่ม คำสั่งนี้เรียก Node tests เท่านั้น: การตรวจ R2 32 ข้อและการตรวจ wiring/hash ของการรวม source ไม่เปิด PowerShell, native harness หรือ inert worker ไม่ใช้ไฟล์งานเก่า และไม่ต้องมีแอป lnwjud เปิดอยู่

คำสั่ง `test` ปกติของโครงการคงเดิม ไม่มี native command หรือ native pre/post hook เพิ่มเข้า CI, release, build หรือการเปิดแอป ผลทดสอบที่สร้างใน `audit/` ถูก Git ignore

## หลักฐานที่นำมารวม

ไฟล์ R2 ทั้ง 7 ไฟล์ใน `scripts/` และตัวตรวจ mock ใน `audit/negative-case-regressions.mjs` คง byte เดิม ตรวจได้จาก `provenance.json` และ integration checks

R2 เคยผ่าน native บน VaGoo เมื่อ 22 ตุลาคม 2569 โดย invocation `64076165-97e2-4e7a-84bb-9af92ccc0edd` หลักฐาน native SHA-256:

```text
0fbfed2419d61f493aca73b63a26d11cbdd24f927438edfb5f3679027b1a44be
```

หลักฐานนั้นเป็นผลของ exact R2 hashes ในสำเนาแยกเดิม การรวม source ที่นี่ตรวจด้วย mock/hash เท่านั้น ไม่ได้เปิด native ที่พาธใน repository ซ้ำ

## การเปิด native เป็นขั้นตอนแยก

`scripts/run-native-owned-check.mjs` เป็นตัวเปิดแบบครั้งเดียวเฉพาะ VAGOO ผูก runtime/Node path และ hash ตรวจ policy เดิม และไม่มี interpreter fallback หรือ policy override

ไม่บรรจุ active `PREFLIGHT.json`, `INPUT_MANIFEST.json`, claim หรือ native result เก่าไว้ใน source จึงไม่สามารถนำการอนุมัติครั้งก่อนมาเปิด native อัตโนมัติได้ Native รอบใหม่ต้องมีขอบเขตอนุมัติใหม่สำหรับ exact revision/run และ fresh preflight จาก VaGoo ใช้สำเนารันแยกเพื่อรักษา claim/ผลเดิมของแต่ละรอบ ห้ามลบ claim แล้ว replay เมื่อผล UNKNOWN/denial/timeout

ขั้นตอน preflight ที่มีสิทธิ์ต้องยืนยัน VAGOO, runtime/Node ที่ pin ไว้, ไม่มี policy override, existing effective policy RemoteSigned และ policy scopes; บันทึก runtime/config/Node hashes กับ policy snapshot ใน `audit/PREFLIGHT.json` แล้วสร้าง `audit/INPUT_MANIFEST.json` ให้ครบ 8 paths ตาม `requiredManifestPaths` ก่อนพิจารณาเปิดตัว runner ผ่าน Guard เดิม ไม่มีขั้นตอนนี้ในคำสั่ง mock

## ข้อจำกัด

พาธเฉพาะ VaGoo และ exit code 23 เป็นส่วนของ fixture ไม่ใช่ runtime resolver สำหรับเครื่องทั่วไป ตัวอ่านถือ Process/handle ของโปรเซสจำลองที่สร้างเอง ไม่ attach PID ของงานเก่า

ผลสำเร็จยังคง `taskWideCompletion=UNKNOWN`, `descendantsVerified=false`, `taskOwnerVerified=false`, `recoveryAuthorization=NONE` ไม่แทน Job Object containment/receipt/cancel/timeout ของแอป และไม่ใช่สิทธิ์ติดตั้งหรือใช้งานบน 5090
