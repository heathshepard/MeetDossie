"""Quick cookie probe - reports if Profile 4 (DossieBot) has Reddit/PlayHT cookies."""
import sqlite3, shutil, tempfile, os, sys

src = r'C:\Users\Heath Shepard\AppData\Local\Google\Chrome\User Data\Default\Network\Cookies'
if not os.path.exists(src):
    print("MISSING:", src); sys.exit(0)

tmp = tempfile.mktemp(suffix='.db')
try:
    shutil.copy(src, tmp)
except PermissionError as e:
    print("LOCKED:", e); sys.exit(0)

c = sqlite3.connect(tmp)
for q in [
    "SELECT host_key, name FROM cookies WHERE host_key LIKE '%reddit%' LIMIT 20",
    "SELECT host_key, name FROM cookies WHERE host_key LIKE '%play.ht%' LIMIT 20",
]:
    print("---", q)
    for row in c.execute(q):
        print(row)
c.close()
os.remove(tmp)
