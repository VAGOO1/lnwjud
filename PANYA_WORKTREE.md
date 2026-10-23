# PANYA Worktree (local baseline)

โฟลเดอร์นี้เป็น **local baseline** ของ source snapshot PANYA ที่แก้ปัญหา duplicate-check และ receipt แล้ว ไม่ใช่ประวัติ release ของ upstream. ใช้ branch `dev`; เจ้าของอนุญาต worktree ที่ร้องขอสำหรับงานแยกได้.

## เตรียม dependency

ต้องใช้ Node.js 24.x และ Corepack. จาก root ของ worktree ให้รัน:

```sh
node scripts/panya-worktree-setup.mjs
```

หาก cache ที่จำเป็นมีครบและต้องทำงานออฟไลน์ ให้เพิ่ม `--offline`.

สคริปต์ตรวจ Node 24 และ `packageManager: pnpm@10.15.0` ก่อนเรียกคำสั่งที่ pinned:

```sh
corepack pnpm@10.15.0 install --frozen-lockfile --ignore-scripts
```

ขั้นนี้ไม่ build, ไม่เปิดแอป, ไม่ deploy, ไม่เปิด browser และไม่เรียกเครื่องมือ 5090. `--ignore-scripts` จึงไม่ได้ติดตั้ง Electron binary; หากงานต้องใช้ Electron/E2E ให้เตรียม binary แยกและใช้โปรไฟล์กับข้อมูลจำลองตามขอบเขตงาน.

หลัง setup ให้ Build จาก root ด้วย:

```sh
corepack pnpm@10.15.0 --filter @lnwjud/desktop... build
```

Git worktree ติดตามเฉพาะ source; dependencies, generated files, runtime และ cache ติดตั้งแยกในแต่ละ worktree และถูก ignore.

เพิ่มโฟลเดอร์ repo นี้เป็นโปรเจกต์ใน Codex ก่อนเลือกสร้าง Worktree. ถ้าต้องการเตรียม dependency อัตโนมัติ สามารถตั้ง Worktree setup command เป็น `node scripts/panya-worktree-setup.mjs` ผ่าน Local environment ของโปรเจกต์ได้. งานจัด repo นี้ไม่ได้เปลี่ยน Settings หรือเขียน `.codex/config.toml` ให้.
