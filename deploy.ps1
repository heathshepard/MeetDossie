# Dossie Deploy Script - run this after every build
cd "C:\Users\Heath Shepard\Desktop\Dossie"
npm run build

$newHash = (Get-ChildItem "C:\Users\Heath Shepard\Desktop\Dossie\dist\assets" -Name).Replace('.js','')
Write-Host "New hash: $newHash"

Remove-Item "C:\Users\Heath Shepard\Desktop\MeetDossie\assets\*" -Force
Copy-Item "C:\Users\Heath Shepard\Desktop\Dossie\dist\assets\*" "C:\Users\Heath Shepard\Desktop\MeetDossie\assets\" -Force
Copy-Item "C:\Users\Heath Shepard\Desktop\Dossie\dist\index.html" "C:\Users\Heath Shepard\Desktop\MeetDossie\workspace.html" -Force

(Get-Content "C:\Users\Heath Shepard\Desktop\MeetDossie\app.html" -Raw) -replace 'workspace-[^"]+\.js', "$newHash.js" | Set-Content "C:\Users\Heath Shepard\Desktop\MeetDossie\app.html"

cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
git add -A
git commit -m "Deploy $newHash"
git push
Write-Host "Done. Deployed $newHash"
