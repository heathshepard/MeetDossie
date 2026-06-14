$envContent = Get-Content "C:\Users\Heath Shepard\Desktop\MeetDossie\.env.local" -Raw
$resend = if ($envContent -match 'RESEND_API_KEY="?([^"\r\n]+)') { $matches[1] } else { $null }

$recipients = @(
  @{ email='kimberlyherrera@kw.com'; first_name='Kimberly'; tier='founding' },
  @{ email='tiffanygillrealtor@gmail.com'; first_name='Tiffany'; tier='founding' },
  @{ email='tgill@phyllisbrowning.com'; first_name='Tiffany'; tier='founding' },
  @{ email='brittney@setxrealty.com'; first_name='Brittney'; tier='founding' },
  @{ email='k.suzanne.page@gmail.com'; first_name='Suzanne'; tier='founding' },
  @{ email='mikirgvrealtor@gmail.com'; first_name='Miki'; tier='founding' },
  @{ email='cecilia@sterlingassociatesre.com'; first_name='Cecilia'; tier='founding' },
  @{ email='michellesellshouston@gmail.com'; first_name='Terry'; tier='founding' },
  @{ email='amanda@amandanuckles.com'; first_name='Amanda'; tier='founding' },
  @{ email='zelda@a2zrealestateconsultants.com'; first_name='Zelda'; tier='founding' },
  @{ email='natalie@localchoicegroup.com'; first_name='Natalie'; tier='founding' },
  @{ email='jenn.casamiateam@gmail.com'; first_name='Jennifer'; tier='founding' },
  @{ email='lisanilssontx@gmail.com'; first_name='Lisa'; tier='founding' }
)

$sent = 0
$failed = 0
foreach ($r in $recipients) {
  $emailText = @"
Hey $($r.first_name),

Quick clarification on your affiliate program, since I just shipped an important update.

How it works now:

When someone signs up with your link, you'll get a notification right away that says "pending qualification." Your reward (`$100 as a founding member, `$50 for others) will lock in after 6 months if their subscription is still active.

This prevents gaming - where someone signs up, we credit the affiliate, and the customer cancels the next month. Now we only credit rewards for referrals that stay active for 6 months, making sure the program stays healthy for everyone.

What this means for you:

Your dashboard now shows two balances:
- Pending qualification - rewards vesting over the next 6 months (shows earliest lock-in date)
- Available balance - rewards already qualified + ready to credit toward your next invoice

Important edge case:

If you cancel your own subscription for any reason, your pending referrals still qualify normally on their 6-month mark. We don't punish you for churning - we just make sure the referred customers stick around. That's the rule.

What happens if a referral cancels before 6 months:

You'll get an email letting you know the reward voided. No hard feelings - just means they weren't the right fit.

Your affiliate link is still live and works the same way. Keep sharing.

- Heath
"@

  $payload = @{
    from = 'Heath Shepard <heath@meetdossie.com>'
    to = @($r.email)
    reply_to = 'heath@meetdossie.com'
    subject = 'Quick affiliate program clarification - 6-month qualification'
    text = $emailText
  } | ConvertTo-Json -Depth 4
  try {
    $resp = Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post -Headers @{ Authorization = "Bearer $resend"; 'Content-Type' = 'application/json' } -Body $payload -ErrorAction Stop
    Write-Output "OK $($r.email) -> $($resp.id)"
    $sent++
  } catch {
    $err = if ($_.ErrorDetails) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Output "ERR $($r.email) -> $err"
    $failed++
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "---"
Write-Output "TOTAL SENT: $sent / $($recipients.Count) (failed: $failed)"
