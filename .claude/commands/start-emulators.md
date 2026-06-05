---
description: Start Firebase Auth + Firestore local emulators
---

Start emulators only (no backend or frontend):

```powershell
.\scripts\start_emulators.ps1
```

Requires JDK 11+ — script auto-sets `JAVA_HOME` to `C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot`.

Ports:
- Auth → :9099
- Firestore → :8080
- UI → http://127.0.0.1:4000
