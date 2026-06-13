$envContent = Get-Content "C:\Users\Heath Shepard\Desktop\MeetDossie\.env.local" -Raw
$resend = if ($envContent -match 'RESEND_API_KEY="?([^"\r\n]+)') { $matches[1] } else { $null }

$recipients = @(
  'tiffanygillrealtor@gmail.com',
  'lisanilssontx@gmail.com',
  'jenn.casamiateam@gmail.com',
  'natalie@localchoicegroup.com',
  'michellesellshouston@gmail.com',
  'amanda@amandanuckles.com',
  'cecilia@sterlingassociatesre.com',
  'kimberlyherrera@kw.com',
  'mikirgvrealtor@gmail.com',
  'tgill@phyllisbrowning.com',
  'brittney@setxrealty.com',
  'k.suzanne.page@gmail.com',
  'heath@meetdossie.com'
)

$emailText = @"
Hey there,

Quick clarification on something I sent this morning. The Friday update mentioned `"Social Media Posts Itself Now`" - that one's actually a feature I'm using for Dossie's own marketing right now, not something live for you yet. My fault - should never have made it into your update. Sorry for the mix-up.

But here's the honest version: that engine IS running, and it's the next big thing we're building out to you. Coming soon, somewhat functioning behind the scenes already.

Here's what it would do for you when it ships:

- Connects your FB / IG / LinkedIn / TikTok via one setup
- Auto-drafts daily posts from your deal updates, market activity, and sphere content
- Sends drafts to your Telegram or in-app for one-tap approval
- Publishes everywhere automatically

Founding pricing would be `$10/mo (`$20/mo regular - same 50% founding lock-in you already have on your core plan).

Three quick questions to help me build it right:

1. Would you actually use this? (Yes / No / Maybe)
2. What platforms do you post on most right now?
3. What's your biggest pain about social media as an agent?

Even one-word answers help.

Thanks for the patience,
Heath
"@

$sent = 0
$failed = 0
foreach ($to in $recipients) {
  $payload = @{
    from = 'Heath Shepard <heath@meetdossie.com>'
    to = @($to)
    reply_to = 'heath@meetdossie.com'
    subject = "Quick fix on this morning's update + a question"
    text = $emailText
  } | ConvertTo-Json -Depth 4
  try {
    $r = Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post -Headers @{ Authorization = "Bearer $resend"; 'Content-Type' = 'application/json' } -Body $payload -ErrorAction Stop
    Write-Output "OK $to -> $($r.id)"
    $sent++
  } catch {
    $err = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Output "ERR $to -> $err"
    $failed++
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "---"
Write-Output "TOTAL SENT: $sent / $($recipients.Count) (failed: $failed)"
