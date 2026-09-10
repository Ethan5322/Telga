---
title: Amharic Strings
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - localization
  - amharic
  - needs-review
related:
  - "[[00 Home]]"
  - "[[Merchant POS Screens]]"
  - "[[English Strings]]"
  - "[[Screen Inventory]]"
  - "[[Decision Log]]"
depends_on:
  - "[[English Strings]]"
implements: []
validates: []
decision_status: pending
---

# Amharic Strings

> [!danger] REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION
> Every Amharic string on this page is a **draft produced by Claude, not a finished translation**.
> None of it has been reviewed by a native Amharic speaker. It must not reach a merchant, a
> receipt, a printed material, or a production build until a named reviewer has signed it off in
> [[Decision Log]].
>
> The highest-risk string on this page is `status.pending.do_not_retry`. If a merchant
> misreads it, they retry, and a retry on a misunderstood pending state is how duplicate sales and
> lost money happen. Review that line first.

**Reviewer:** NOT YET ASSIGNED
**Review status:** NOT REVIEWED
**Target register:** simple professional Amharic suitable for shop owners — not academic, not
literal-from-English.

## Merchant-critical terms

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `sale.action.sell_airtime` | Sell airtime | አየር ሰዓት ሽጥ | ☐ |
| `sale.amount.select` | Select amount | መጠን ይምረጡ | ☐ |
| `sale.confirm.action` | Confirm sale | ሽያጩን ያረጋግጡ | ☐ |
| `status.processing` | Processing | በሂደት ላይ | ☐ |
| `status.pending` | Transaction pending | ግብይቱ በመጠባበቅ ላይ ነው | ☐ |
| `status.pending.do_not_retry` | Do not retry yet | እባክዎ ገና አይድገሙት | ☐ **priority** |
| `status.successful` | Transaction successful | ግብይቱ ተሳክቷል | ☐ |
| `status.failed` | Transaction failed | ግብይቱ አልተሳካም | ☐ |
| `status.under_review` | Under review | በምርመራ ላይ | ☐ |
| `status.provider_unavailable` | Provider temporarily unavailable | አቅራቢው ለጊዜው አገልግሎት አይሰጥም | ☐ |
| `status.sales_unavailable` | Sales temporarily unavailable | ሽያጭ ለጊዜው አይቻልም | ☐ |
| `status.no_charge` | No charge was made | ምንም ክፍያ አልተቀነሰም | ☐ |
| `balance.available` | Available balance | ዝግጁ ቀሪ ሂሳብ | ☐ |
| `balance.reserved` | Reserved balance | የተያዘ ቀሪ ሂሳብ | ☐ |
| `balance.under_review` | Under review balance | በምርመራ ላይ ያለ ቀሪ ሂሳብ | ☐ |
| `commission.net` | Net commission | የተጣራ ኮሚሽን | ☐ |
| `receipt.reprint` | Reprint receipt | ደረሰኝ እንደገና ያትሙ | ☐ |
| `transaction.id` | Transaction ID | የግብይት መለያ ቁጥር | ☐ |
| `support.contact` | Contact support | ድጋፍ ያግኙ | ☐ |
| `mode.training` | Training mode — no real value | የልምምድ ሁኔታ — እውነተኛ ዋጋ የለውም | ☐ |

## Full messages

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `status.pending.message` | This transaction is still being checked. Do not retry yet. | ይህ ግብይት አሁንም እየተጣራ ነው። እባክዎ ገና አይድገሙት። | ☐ **priority** |
| `status.under_review.message` | This transaction is being reviewed. Your balance is protected while we check with the provider. | ይህ ግብይት በምርመራ ላይ ነው። ከአቅራቢው ጋር እያጣራን ስንቆይ ቀሪ ሂሳብዎ የተጠበቀ ነው። | ☐ |
| `status.failed.message` | This sale did not go through. No charge was made. | ይህ ሽያጭ አልተፈጸመም። ምንም ክፍያ አልተቀነሰም። | ☐ |
| `status.provider_unavailable.message` | Airtime is temporarily unavailable from this provider. No charge was made. Other services are still working. | ከዚህ አቅራቢ የአየር ሰዓት ለጊዜው አይገኝም። ምንም ክፍያ አልተቀነሰም። ሌሎች አገልግሎቶች እየሠሩ ናቸው። | ☐ |
| `status.offline.message` | Sales are temporarily unavailable. You can still view history, reports and support. | ሽያጭ ለጊዜው አይቻልም። ታሪክ፣ ሪፖርቶችና ድጋፍ አሁንም ማየት ይችላሉ። | ☐ |
| `receipt.reprint.notice` | This is a reprint. It is not a new sale. | ይህ እንደገና የታተመ ደረሰኝ ነው። አዲስ ሽያጭ አይደለም። | ☐ |
| `funding.simulated.notice` | This is a simulated funding submission. No real money is involved. | ይህ የሙከራ የገንዘብ ማስገቢያ ነው። እውነተኛ ገንዘብ አልተካተተም። | ☐ |

## Errors

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `error.validation.recipient` | Check the phone number and try again. | የስልክ ቁጥሩን አረጋግጠው እንደገና ይሞክሩ። | ☐ |
| `error.balance.insufficient` | Not enough available balance for this sale. | ለዚህ ሽያጭ በቂ ዝግጁ ቀሪ ሂሳብ የለም። | ☐ |
| `error.permission.denied` | Your role does not allow this action. | የእርስዎ ሚና ይህን ተግባር አይፈቅድም። | ☐ |
| `error.session.expired` | Your session has ended. Sign in again. Nothing was lost. | ክፍለ ጊዜዎ አብቅቷል። እንደገና ይግቡ። ምንም አልጠፋም። | ☐ |
| `error.printer.failed` | The receipt did not print. The sale is complete — you can reprint it. | ደረሰኙ አልታተመም። ሽያጩ ተጠናቋል — እንደገና ማተም ይችላሉ። | ☐ |
| `error.duplicate.blocked` | This sale is already in progress. Do not start it again. | ይህ ሽያጭ አስቀድሞ በሂደት ላይ ነው። እንደገና አይጀምሩት። | ☐ |
| `error.network_unavailable` | Telga could not be reached. The result of this sale is not known yet — do not retry it. | ቴልጋ ላይ መድረስ አልተቻለም። የዚህ ሽያጭ ውጤት እስካሁን አይታወቅም — እንደገና አይሞክሩ። | ☐ |

## Training voucher flow (simulated)

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `voucher.action.print` | PRINT | አትም | ☐ |
| `voucher.action.cancel` | CANCEL | ሰርዝ | ☐ |
| `voucher.action.back` | BACK | ተመለስ | ☐ |
| `voucher.action.continue` | Continue | ቀጥል | ☐ |
| `voucher.product.airtime` | Airtime | አየር ሰዓት | ☐ |
| `voucher.data.unavailable` | Not available in training | በልምምድ ውስጥ አይገኝም | ☐ |
| `voucher.pin.prompt` | Enter PIN to buy training voucher | የልምምድ ቫውቸር ለመግዛት ፒን ያስገቡ | ☐ **priority** |
| `voucher.pin.clear` | Clear | አጽዳ | ☐ |
| `voucher.pin.confirm` | OK / CONFIRM | እሺ / አረጋግጥ | ☐ |
| `voucher.result.no_printer` | Training voucher shown on screen — no physical printer configured. | የልምምድ ቫውቸር በስክሪኑ ላይ ታይቷል — አታሚ አልተዘጋጀም። | ☐ |
| `voucher.result.preview_notice` | Preview only. PIN verification and voucher creation are not yet active — no training voucher was recorded. | ቅድመ እይታ ብቻ። የፒን ማረጋገጫና የቫውቸር መፍጠር እስካሁን አልነቃም — ምንም የልምምድ ቫውቸር አልተመዘገበም። | ☐ |
| `voucher.result.new_sale` | New sale | አዲስ ሽያጭ | ☐ |
| `voucher.amount.invalid` | Select a valid amount for this network. | ለዚህ አውታረ መረብ ትክክለኛ መጠን ይምረጡ። | ☐ |
| `sale.amount.select_placeholder` | Select airtime amount | የአየር ሰዓት መጠን ይምረጡ | ☐ |
| `sale.amount.custom` | Custom amount | ሌላ መጠን | ☐ |
| `sale.amount.custom_label` | Amount in birr | መጠን በብር | ☐ |
| `sale.amount.custom.below_min` | That amount is below the training minimum. | ይህ መጠን ከልምምድ ዝቅተኛ በታች ነው። | ☐ |
| `sale.amount.custom.above_max` | That amount is above the training maximum. | ይህ መጠን ከልምምድ ከፍተኛ በላይ ነው። | ☐ |
| `sale.amount.custom.not_multiple` | Enter a whole number of birr. | ሙሉ የብር ቁጥር ያስገቡ። | ☐ |
| `sale.amount.custom.not_a_number` | Enter a valid amount. | ትክክለኛ መጠን ያስገቡ። | ☐ |
| `voucher.pin.heading` | Confirm transaction PIN | የግብይት ፒን ያረጋግጡ | ☐ **priority** |
| `voucher.product.topup` | Direct top-up | ቀጥታ ሙሌት | ☐ |
| `voucher.summary.merchant` | Training merchant | የልምምድ ነጋዴ | ☐ |
| `voucher.summary.amount` | Amount | መጠን | ☐ |
| `voucher.summary.total` | Total | ጠቅላላ | ☐ |
| `voucher.summary.profit` | Your profit | የእርስዎ ትርፍ | ☐ |
| `voucher.summary.recipient` | Phone number | ስልክ ቁጥር | ☐ |
| `topup.tile.label` | Top up a phone | ስልክ ሙላ | ☐ |
| `topup.phone.label` | Customer phone number | የደንበኛ ስልክ ቁጥር | ☐ |
| `topup.phone.hint` | The number the airtime is sent to. | አየር ሰዓቱ የሚላክበት ቁጥር። | ☐ |
| `topup.phone.invalid` | Enter a valid phone number. | ትክክለኛ ስልክ ቁጥር ያስገቡ። | ☐ |
| `topup.phone.required` | A phone number is required for a direct top-up. | ለቀጥታ ሙሌት ስልክ ቁጥር ያስፈልጋል። | ☐ |
| `nav.main` | Main | ዋና | ☐ |
| `card.read` | Read card | ካርድ አንብብ | ☐ |
| `card.declined_heading` | Not approved | አልጸደቀም | ☐ |
| `card.no_response_heading` | No answer from the bank | ከባንኩ ምላሽ የለም | ☐ |
| `card.try_again` | Ask the customer to try again with the same card. | ደንበኛው በተመሳሳይ ካርድ እንደገና ይሞክር። | ☐ |
| `card.number` | Card | ካርድ | ☐ |
| `card.scheme` | Type | ዓይነት | ☐ |
| `card.entry_mode` | Read by | የተነበበበት | ☐ |
| `card.simulator_title` | Training card — a real reader supplies this itself | የሥልጠና ካርድ — እውነተኛ አንባቢ ይህንን ራሱ ያቀርባል | ☐ |
| `settings.shift.hint` | A shift records when an operator started and finished. It holds no money of its own. | ፈረቃ ኦፕሬተሩ የጀመረበትንና የጨረሰበትን ጊዜ ይመዘግባል። የራሱ ገንዘብ የለውም። | ☐ |
| `settings.shift.statement` | Statement for this shift | የዚህ ፈረቃ መግለጫ | ☐ |
| `settings.account.operator` | Operator | ኦፕሬተር | ☐ |
| `settings.account.device` | Device | መሣሪያ | ☐ |
| `settings.account.merchant` | Merchant | ነጋዴ | ☐ |
| `settings.account.hint` | Telga signs in with an operator ID, a PIN and a device key — there is no password. Use Change PIN below. | ተልጋ በኦፕሬተር መለያ፣ በፒን እና በመሣሪያ ቁልፍ ይገባል — የይለፍ ቃል የለም። ከታች ያለውን ፒን ቀይር ይጠቀሙ። | ☐ |
| `outage.heading` | Service unavailable | አገልግሎቱ አይገኝም | ☐ |
| `outage.unavailable` | not available right now | አሁን አይገኝም | ☐ |
| `outage.no_charge` | Nothing was charged. No sale was made and no commission was earned. | ምንም አልተከፈለም። ሽያጭ አልተደረገም፤ ኮሚሽንም አልተገኘም። | ☐ |
| `outage.last_checked` | Last checked | የመጨረሻ ማረጋገጫ | ☐ |
| `outage.still_available` | Still available | አሁንም የሚገኙ | ☐ |
| `offline.heading` | Telga is not reachable | ተልጋ አይገኝም | ☐ |
| `offline.no_sales` | No new sales can be made until the connection returns. | ግንኙነቱ እስኪመለስ ድረስ አዲስ ሽያጭ ማድረግ አይቻልም። | ☐ |
| `offline.no_offline_vending` | Selling offline is not allowed. Do not take money for a sale this machine cannot complete. | ከመስመር ውጭ መሸጥ አይፈቀድም። ይህ መሣሪያ ሊጨርሰው ለማይችል ሽያጭ ገንዘብ አይቀበሉ። | ☐ |
| `offline.last_seen` | Last connected | የመጨረሻ ግንኙነት | ☐ |
| `offline.still_available` | What still works | አሁንም የሚሠሩ | ☐ |
| `dashboard.low_balance` | Your selling balance is running low. Top up before it runs out. | የመሸጫ ቀሪ ሂሳብዎ እያለቀ ነው። ከማለቁ በፊት ይሙሉ። | ☐ |
| `statements.admin_only` | Statements are set to owner-only. Ask the shop owner to view them. | መግለጫዎች ለባለቤት ብቻ ተዘጋጅተዋል። የሱቁን ባለቤት ይጠይቁ። | ☐ |
| `card.decline.insufficient_funds` | Not enough money on the card. Nothing was charged. | በካርዱ ላይ በቂ ገንዘብ የለም። ምንም አልተከፈለም። | ☐ |
| `card.decline.wrong_pin` | Wrong card PIN. Ask the customer to try again. | የካርድ ፒን ትክክል አይደለም። ደንበኛው እንደገና ይሞክር። | ☐ |
| `card.decline.expired` | That card has expired. Nothing was charged. | የካርዱ ጊዜ አልፎበታል። ምንም አልተከፈለም። | ☐ |
| `card.decline.blocked` | That card is blocked. Nothing was charged. | ካርዱ ታግዷል። ምንም አልተከፈለም። | ☐ |
| `card.decline.limit` | That amount is over the card limit. Nothing was charged. | መጠኑ ከካርዱ ገደብ በላይ ነው። ምንም አልተከፈለም። | ☐ |
| `card.decline.issuer` | The bank did not answer. Try again in a moment. | ባንኩ አልመለሰም። ከጥቂት ጊዜ በኋላ ይሞክሩ። | ☐ |
| `card.decline.generic` | The card was declined. Nothing was charged. | ካርዱ ተቀባይነት አላገኘም። ምንም አልተከፈለም። | ☐ |
| `card.no_response` | The bank has not answered. Do not retry and do not hand over goods yet — check the transaction before continuing. | ባንኩ አልመለሰም። እንደገና አይሞክሩ፤ ዕቃም አይስጡ — በመጀመሪያ ግብይቱን ያረጋግጡ። | ☐ |
| `card.not_read` | The card was not read. Ask the customer to present it again. | ካርዱ አልተነበበም። ደንበኛው እንደገና ያቅርብ። | ☐ |
| `card.no_reader` | No card reader is connected to this device. | በዚህ መሣሪያ ላይ የካርድ አንባቢ አልተገናኘም። | ☐ |
| `card.present` | Tap, insert or swipe the card | ካርዱን ይንኩ፣ ያስገቡ ወይም ያንሸራትቱ | ☐ |
| `card.approved` | Approved | ጸድቋል | ☐ |
| `card.reference` | Authorisation | የፈቃድ ቁጥር | ☐ |
| `receipt.lookup_title` | Shop copy — lookup | የሱቅ ቅጂ — ፍለጋ | ☐ |
| `receipt.lookup_note` | Keep this to find the sale again. | ሽያጩን እንደገና ለማግኘት ይህንን ያስቀምጡ። | ☐ |
| `menu.lock` | Lock | ቁልፍ | ☐ |
| `menu.manage` | Manage | አስተዳደር | ☐ |
| `lock.heading` | Screen locked | ማያ ገጹ ተቆልፏል | ☐ |
| `lock.pin_label` | Enter your PIN to unlock | ለመክፈት ፒንዎን ያስገቡ | ☐ |
| `lock.unlock` | Unlock | ክፈት | ☐ |
| `lock.wrong` | That PIN is not correct. The screen stays locked. | ያስገቡት ፒን ትክክል አይደለም። ማያ ገጹ ተቆልፎ ይቆያል። | ☐ |
| `menu.open` | Open menu | ምናሌ ክፈት | ☐ |
| `menu.statements` | Statements | መግለጫዎች | ☐ |
| `menu.end_shift` | End shift | ፈረቃ ጨርስ | ☐ |
| `menu.customers` | Customer list | የደንበኞች ዝርዝር | ☐ |
| `menu.learning` | Learning | ትምህርት | ☐ |
| `menu.settings` | Settings | ቅንብሮች | ☐ |
| `menu.help` | Help | እገዛ | ☐ |
| `menu.logout` | Log out | ውጣ | ☐ |
| `screen.help` | Telga support | የተልጋ ድጋፍ | ☐ |
| `screen.learning` | How to use Telga | ተልጋን እንዴት እንደሚጠቀሙ | ☐ |
| `screen.customers` | Customer list | የደንበኞች ዝርዝር | ☐ |
| `screen.end_shift` | End shift | ፈረቃ ጨርስ | ☐ |
| `help.intro` | Telga support, for anything this machine cannot answer. | ይህ መሣሪያ መመለስ ለማይችለው ማንኛውም ነገር የተልጋ ድጋፍ። | ☐ |
| `help.phone` | Phone | ስልክ | ☐ |
| `help.email` | Email | ኢሜይል | ☐ |
| `help.hours` | Hours | የሥራ ሰዓት | ☐ |
| `help.address` | Address | አድራሻ | ☐ |
| `help.reference_hint` | Have the transaction reference from the slip ready — it is the fastest way to find a sale. | ከደረሰኙ ላይ ያለውን የግብይት ማጣቀሻ ያዘጋጁ — ሽያጭን ለማግኘት ፈጣኑ መንገድ ነው። | ☐ |
| `learning.intro` | Each step below is one thing to try on this machine. Work through them in order. | ከታች ያለው እያንዳንዱ ደረጃ በዚህ መሣሪያ ላይ የሚሞክሩት አንድ ነገር ነው። በቅደም ተከተል ይሂዱ። | ☐ |
| `customers.empty` | No saved customers yet. | እስካሁን የተቀመጠ ደንበኛ የለም። | ☐ |
| `customers.name` | Customer name | የደንበኛ ስም | ☐ |
| `customers.phone` | Phone number | ስልክ ቁጥር | ☐ |
| `customers.add` | Save customer | ደንበኛ አስቀምጥ | ☐ |
| `customers.privacy` | Saved numbers are stored masked, the same way a slip prints them. | የተቀመጡ ቁጥሮች ደረሰኝ እንደሚያትማቸው ተሸፍነው ይቀመጣሉ። | ☐ |
| `customers.invalid` | Enter a name and a valid phone number. | ስም እና ትክክለኛ ስልክ ቁጥር ያስገቡ። | ☐ |
| `shift.open_since` | Shift open since | ፈረቃ የተከፈተው ከ | ☐ |
| `shift.none_open` | No shift is open. | የተከፈተ ፈረቃ የለም። | ☐ |
| `shift.end` | End shift | ፈረቃ ጨርስ | ☐ |
| `shift.end_confirm` | End this shift? | ይህን ፈረቃ ይጨርሱ? | ☐ |
| `shift.ended` | Shift ended. | ፈረቃ ተጠናቋል። | ☐ |
| `settings.section.shift` | Shift settings | የፈረቃ ቅንብሮች | ☐ |
| `settings.section.account` | Account settings | የመለያ ቅንብሮች | ☐ |
| `settings.section.app` | In-app settings | የመተግበሪያ ቅንብሮች | ☐ |
| `settings.section.admin` | Admin only | ለአስተዳዳሪ ብቻ | ☐ |
| `settings.section.security` | Security | ደህንነት | ☐ |
| `settings.section.about` | About and policies | ስለ እና ፖሊሲዎች | ☐ |
| `settings.toggle.sound` | Play sound | ድምጽ አጫውት | ☐ |
| `settings.toggle.hide_balance` | Hide Telga balance | የተልጋ ቀሪ ሂሳብ ደብቅ | ☐ |
| `settings.toggle.low_balance` | Alert me when balance is low | ቀሪ ሂሳብ ሲያንስ አሳውቀኝ | ☐ |
| `settings.toggle.statements_admin` | Statements viewable by admin only | መግለጫዎች በአስተዳዳሪ ብቻ ይታዩ | ☐ |
| `settings.toggle.print_barcode` | Print barcode on slips | በደረሰኝ ላይ ባርኮድ አትም | ☐ |
| `settings.toggle.print_lookup` | Print lookup slip | የፍለጋ ደረሰኝ አትም | ☐ |
| `settings.toggle.pin_lock` | Require PIN to unlock | ለመክፈት ፒን ይጠየቅ | ☐ |
| `settings.lock_seconds` | Lock the screen after (seconds) | ማያ ገጹ የሚቆለፍበት ጊዜ (ሰከንድ) | ☐ |
| `settings.account.phone` | Change phone number | ስልክ ቁጥር ቀይር | ☐ |
| `settings.account.password` | Change password | የይለፍ ቃል ቀይር | ☐ |
| `settings.account.details` | Change your details | መረጃዎን ይቀይሩ | ☐ |
| `settings.about.telga` | About Telga | ስለ ተልጋ | ☐ |
| `settings.about.terms` | Terms and conditions | ውሎች እና ሁኔታዎች | ☐ |
| `settings.about.privacy` | Privacy policy | የግላዊነት ፖሊሲ | ☐ |
| `settings.about.cookies` | Cookie policy | የኩኪ ፖሊሲ | ☐ |
| `settings.back` | Back | ተመለስ | ☐ |
| `balance.top_up` | Top up your balance | ቀሪ ሂሳብዎን ይሙሉ | ☐ |
| `balance.top_up.open` | Add to balance | ወደ ቀሪ ሂሳብ ጨምር | ☐ |
| `balance.top_up.bank` | Bank deposit | የባንክ ተቀማጭ | ☐ |
| `balance.top_up.pay` | Telga Pay balance | የተልጋ ፔይ ቀሪ ሂሳብ | ☐ |
| `balance.top_up.profit` | Profit | ትርፍ | ☐ |
| `screen.launcher` | Telga | ተልጋ | ☐ |
| `statements.title` | Statement | መግለጫ | ☐ |
| `statements.from` | From | ከ | ☐ |
| `statements.to` | To | እስከ | ☐ |
| `statements.apply` | Apply | ተግብር | ☐ |
| `statements.clear` | Clear | አጽዳ | ☐ |
| `statements.sales` | Sales | ሽያጮች | ☐ |
| `statements.gross` | Sold | የተሸጠ | ☐ |
| `statements.profit` | Profit | ትርፍ | ☐ |
| `statements.reversals` | Reversed | የተመለሱ | ☐ |
| `statements.total` | Total | ጠቅላላ | ☐ |
| `statements.note` | Profit is what was earned on each day. Moving profit into the selling balance is not a sale and is not subtracted here; a reversed sale is. | ትርፍ በእያንዳንዱ ቀን የተገኘው ነው። ትርፍን ወደ መሸጫ ቀሪ ሂሳብ ማዘዋወር ሽያጭ አይደለም፤ የተመለሰ ሽያጭ ግን ይቀነሳል። | ☐ |
| `screen.pay_settings` | Telga Pay settings | የቴልጋ ፔይ ቅንብሮች | ☐ |
| `pay.records.transactions_title` | Telga Pay transactions | የቴልጋ ፔይ ግብይቶች | ☐ |
| `pay.records.statements_title` | Telga Pay statements | የቴልጋ ፔይ መግለጫዎች | ☐ |
| `pay.records.cards_not_stored` | Card attempts are not recorded. A simulated card moves no value, so nothing is written to the ledger for one. Training deposits are recorded, because they post a real balanced entry against the float. | የካርድ ሙከራዎች አይመዘገቡም። የተመሰለ ካርድ ዋጋ ስለማያንቀሳቅስ በመዝገቡ ላይ ምንም አይጻፍም። የልምምድ ተቀማጮች ግን ይመዘገባሉ። | ☐ |
| `pay.records.empty` | Nothing recorded yet. | እስካሁን የተመዘገበ የለም። | ☐ |
| `pay.records.count` | Entries | ብዛት | ☐ |
| `pay.settings.flag_card_note` | The card simulator. Nothing behind it reaches a bank. | የካርድ አስመሳይ። ከኋላው ወደ ባንክ የሚደርስ የለም። | ☐ |
| `pay.settings.flag_accept_note` | Real card acceptance. Needs an acquirer and a licence. | እውነተኛ የካርድ ክፍያ መቀበል። አግኚና ፈቃድ ይፈልጋል። | ☐ |
| `pay.settings.flag_deposit_note` | Simulated deposits into the training float. | ወደ የልምምድ ቀሪ ሂሳብ የተመሰለ ተቀማጭ። | ☐ |
| `pay.settings.flag_cash_note` | Taking cash in or paying it out. Legal review required. | ጥሬ ገንዘብ መቀበል ወይም መክፈል። ሕጋዊ ግምገማ ያስፈልጋል። | ☐ |
| `pay.settings.intro` | These settings belong to Telga Pay. Slip width and business details are shared with Telga Vending and are set there. | እነዚህ ቅንብሮች የቴልጋ ፔይ ናቸው። የሱቁ ደረሰኝና የንግድ ዝርዝሮች ከቴልጋ ሽያጭ ጋር የተጋሩ ናቸው። | ☐ |
| `pay.settings.records` | Records | መዝገቦች | ☐ |
| `pay.settings.transactions` | Card transactions | የካርድ ግብይቶች | ☐ |
| `pay.settings.statements` | Card statements | የካርድ መግለጫዎች | ☐ |
| `pay.settings.cards` | Training cards | የልምምድ ካርዶች | ☐ |
| `pay.settings.cards_hint` | A reference sheet, not a setting. These cards are fixed in the simulator so each outcome can be practised on demand. | ማመሳከሪያ ነው፤ ቅንብር አይደለም። እነዚህ ካርዶች በአስመሳዩ ውስጥ ቋሚ ናቸው። | ☐ |
| `pay.settings.flags` | What is switched on | የበራው | ☐ |
| `pay.settings.flag_on` | On | በርቷል | ☐ |
| `pay.settings.flag_off` | Off | ጠፍቷል | ☐ |
| `pay.settings.slips` | Slips | ደረሰኞች | ☐ |
| `pay.settings.slips_note` | Slip width, the advertisement line and the business details print on every Telga slip, card or voucher. They are one shop identity and are set in Telga Vending settings. | የደረሰኝ ስፋትና የንግድ ዝርዝሮች በሁሉም የቴልጋ ደረሰኞች ላይ ይታተማሉ። በቴልጋ ሽያጭ ቅንብሮች ውስጥ ይዘጋጃሉ። | ☐ |
| `pay.settings.account` | Signed in as | የገባው | ☐ |
| `pay.settings.operator` | Operator | ኦፕሬተር | ☐ |
| `pay.settings.device` | Device | መሣሪያ | ☐ |
| `pay.settings.merchant` | Merchant | ነጋዴ | ☐ |
| `settings.slip_size` | Slip width | የደረሰኝ ስፋት | ☐ |
| `screen.launcher_apps` | Choose Telga service | የተልጋ አገልግሎት ይምረጡ | ☐ |
| `screen.profit_transfer` | Move profit to selling balance | ትርፍን ወደ መሸጫ ቀሪ ሂሳብ ያዛውሩ | ☐ |
| `profit.transfer.action` | Move to selling balance | ወደ መሸጫ ቀሪ ሂሳብ ያዛውሩ | ☐ |
| `profit.transfer.available` | Profit available to move | ሊዛወር የሚችል ትርፍ | ☐ |
| `profit.transfer.amount_label` | Amount in birr | መጠን በብር | ☐ |
| `profit.transfer.amount_invalid` | Enter a whole number of birr, at least 1. | ቢያንስ 1፣ ሙሉ ቁጥር ብር ያስገቡ። | ☐ |
| `profit.transfer.exceeds` | That is more than the profit you have. Nothing was moved. | ካለዎት ትርፍ ይበልጣል። ምንም አልተዛወረም። | ☐ |
| `profit.transfer.confirm` | OK | እሺ | ☐ |
| `profit.transfer.done` | Moved to your selling balance. | ወደ መሸጫ ቀሪ ሂሳብዎ ተዛውሯል። | ☐ |
| `profit.transfer.remaining` | Profit remaining | የቀረው ትርፍ | ☐ |
| `profit.transfer.new_balance` | New selling balance | አዲስ የመሸጫ ቀሪ ሂሳብ | ☐ |
| `profit.transfer.none` | There is no profit to move yet. | እስካሁን የሚዛወር ትርፍ የለም። | ☐ |
| `settings.pin.heading` | Change transaction PIN | የግብይት ፒን ይቀይሩ | ☐ |
| `settings.pin.current` | Current PIN | የአሁኑ ፒን | ☐ |
| `settings.pin.new` | New PIN | አዲስ ፒን | ☐ |
| `settings.pin.confirm` | Confirm new PIN | አዲሱን ፒን ያረጋግጡ | ☐ |
| `settings.pin.save` | Change PIN | ፒን ቀይር | ☐ |
| `settings.pin.changed` | Transaction PIN changed. Use the new PIN from now on. | የግብይት ፒን ተቀይሯል። ከአሁን በኋላ አዲሱን ፒን ይጠቀሙ። | ☐ |
| `settings.pin.wrong_current` | That current PIN is not correct. Nothing was changed. | ያስገቡት የአሁኑ ፒን ትክክል አይደለም። ምንም አልተቀየረም። | ☐ |
| `settings.pin.weak` | Choose a different six-digit PIN. Avoid 111111 or 123456. | ሌላ ባለ ስድስት አኃዝ ፒን ይምረጡ። 111111 ወይም 123456 ያስወግዱ። | ☐ |
| `settings.pin.mismatch` | The two new PINs do not match. Nothing was changed. | ሁለቱ አዲስ ፒኖች አይመሳሰሉም። ምንም አልተቀየረም። | ☐ |
| `settings.business.heading` | Business details | የንግድ መረጃ | ☐ |
| `settings.business.hint` | Printed on every slip. Telga does not verify these. | በእያንዳንዱ ደረሰኝ ላይ ይታተማል። ተልጋ እነዚህን አያረጋግጥም። | ☐ |
| `settings.business.name` | Business name | የንግድ ስም | ☐ |
| `settings.business.address` | Address | አድራሻ | ☐ |
| `settings.business.phone` | Shop phone number | የሱቅ ስልክ ቁጥር | ☐ |
| `settings.business.tin` | TIN | የግብር መለያ ቁጥር | ☐ |
| `settings.business.licence` | Trade licence number | የንግድ ፈቃድ ቁጥር | ☐ |
| `settings.business.footer` | Closing line on the slip | በደረሰኙ ላይ የመዝጊያ መስመር | ☐ |
| `launcher.open_telga` | Tap Telga to open | ቴልጋን ለመክፈት ይንኹ | ☐ |
| `voucher.quantity.label` | How many vouchers | ስንት ቫውቸሮች | ☐ |
| `voucher.quantity.invalid` | Choose between 1 and 20 vouchers. | ከ1 እስከ 20 ቫውቸሮች ይምረጡ። | ☐ |
| `voucher.quantity.decrease` | One fewer | አንድ ይቀንሱ | ☐ |
| `voucher.quantity.increase` | One more | አንድ ይጨምሩ | ☐ |
| `voucher.summary.quantity` | Vouchers | ቫውቸሮች | ☐ |
| `voucher.summary.each` | Price each | የአንዱ ዋጋ | ☐ |
| `receipt.slip.batch_position` | Voucher | ቫውቸር | ☐ |
| `voucher.action.main` | MAIN | ዋና | ☐ |
| `voucher.action.main_confirm` | Leave this sale and go to the main screen? No voucher will be issued. | ይህን ሽያጭ ትተው ወደ ዋናው ማያ ገጽ ይሂዱ? ምንም ቫውቸር አይሰጥም። | ☐ |
| `voucher.product.data` | Data | ዳታ | ☐ |
| `data.category.select` | Choose a data type | የዳታ ዓይነት ይምረጡ | ☐ |
| `data.package.select` | Choose a package | ጥቅል ይምረጡ | ☐ |
| `data.column.volume` | Bundle | ጥቅል | ☐ |
| `data.column.validity` | Valid for | የሚያገለግልበት ጊዜ | ☐ |
| `data.phone.label` | Customer phone number | የደንበኛ ስልክ ቁጥር | ☐ |
| `data.phone.required` | A phone number is required for a data bundle. | ለዳታ ጥቅል ስልክ ቁጥር ያስፈልጋል። | ☐ |
| `data.category.monthly` | Monthly | ወርሃዊ | ☐ |
| `data.category.weekly` | Weekly | ሳምንታዊ | ☐ |
| `data.category.daily` | Daily | ዕለታዊ | ☐ |
| `data.category.hourly` | Hourly | በሰዓት | ☐ |
| `data.category.weekend` | Weekend | የሳምንት መጨረሻ | ☐ |
| `data.category.all_access` | All-Access | ሙሉ መዳረሻ | ☐ |
| `data.category.lte` | LTE | ኤልቲኢ | ☐ |
| `data.category.social` | Social | ማህበራዊ | ☐ |
| `data.category.voice` | Voice | ድምጽ | ☐ |
| `receipt.slip.network_code` | Network | ኔትወርክ | ☐ |
| `receipt.slip.voucher_pin` | Voucher PIN | የቫውቸር ፒን | ☐ |
| `receipt.slip.token_reference` | Token reference | የቶክን ማጣቀሻ | ☐ |
| `receipt.slip.dial_string` | To load, dial | ለመሙላት ይደውሉ | ☐ |
| `receipt.slip.simulated_code_notice` | SIMULATED CODE — will not load airtime | የተመሰለ ኮድ — አየር ሰዓት አይሞላም | ☐ |
| `voucher.error.insufficient_balance` | Insufficient training balance. No voucher was issued. | በቂ የልምምድ ቀሪ ሂሳብ የለም። ምንም ቫውቸር አልተሰጠም። | ☐ **priority** |
| `voucher.error.order_expired` | This order expired before it was confirmed. No voucher was issued. | ይህ ትዕዛዝ ከመረጋገጡ በፊት ጊዜው አልፎበታል። ምንም ቫውቸር አልተሰጠም። | ☐ |
| `voucher.error.order_not_open` | This order was already completed or cancelled. No voucher was issued. | ይህ ትዕዛዝ አስቀድሞ ተጠናቅቋል ወይም ተሰርዟል። ምንም ቫውቸር አልተሰጠም። | ☐ |
| `voucher.error.duplicate` | This voucher was already issued. It was not issued again. | ይህ ቫውቸር አስቀድሞ ተሰጥቷል። እንደገና አልተሰጠም። | ☐ |
| `voucher.error.generic` | The voucher could not be completed. No voucher was issued. | ቫውቸሩን ማጠናቀቅ አልተቻለም። ምንም ቫውቸር አልተሰጠም። | ☐ **priority** |
| `voucher.result.failed_title` | Voucher not issued | ቫውቸር አልተሰጠም | ☐ |
| `voucher.action.back_to_vouchers` | Back to Vouchers | ወደ ቫውቸሮች ተመለስ | ☐ |
| `voucher.action.home` | Home | መነሻ | ☐ |
| `receipt.not_available` | No receipt is available for this transaction yet. | ለዚህ ግብይት እስካሁን ደረሰኝ አይገኝም። | ☐ |
| `receipt.slip.title` | Transaction slip | የግብይት ደረሰኝ | ☐ |
| `receipt.slip.reprint_notice` | REPRINT — not a new sale | እንደገና የታተመ — አዲስ ሽያጭ አይደለም | ☐ **priority** |
| `receipt.action.close` | Close | ዝጋ | ☐ |
| `receipt.action.print` | Print | አትም | ☐ |
| `receipt.print.failed` | Printing could not be completed. The transaction is unchanged. | ማተም አልተጠናቀቀም። ግብይቱ አልተለወጠም። | ☐ |
| `transactions.empty` | No transactions yet. | እስካሁን ምንም ግብይት የለም። | ☐ |
| `transactions.column.datetime` | Date and time | ቀን እና ሰዓት | ☐ |
| `transactions.column.service` | Service | አገልግሎት | ☐ |
| `transactions.column.amount` | Amount | መጠን | ☐ |
| `transactions.column.status` | Status | ሁኔታ | ☐ |
| `transactions.column.reference` | Reference | ማጣቀሻ | ☐ |
| `voucher.pin.wrong` | Incorrect transaction PIN. No voucher was issued. | የተሳሳተ የግብይት ፒን። ምንም ቫውቸር አልተሰጠም። | ☐ **priority** |
| `voucher.pin.locked` | Too many incorrect PIN attempts. Voucher authorization is locked for a few minutes. Your login is not affected. | በጣም ብዙ የተሳሳቱ የፒን ሙከራዎች። የቫውቸር ማረጋገጫ ለጥቂት ደቂቃዎች ተቆልፏል። መግቢያዎ አልተነካም። | ☐ **priority** |

## Telga launcher and dashboard

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `launcher.tile.telga.label` | TELGA | ቴልጋ | ☐ |
| `launcher.tile.telga.subtitle` | Vending and merchant services | ሽያጭና የነጋዴ አገልግሎቶች | ☐ |
| `launcher.tile.telgapay.label` | TELGA PAY | ቴልጋ ፔይ | ☐ |
| `launcher.tile.telgapay.subtitle` | Card-payment training simulator | የልምምድ የካርድ ክፍያ አስመሳይ | ☐ |
| `dashboard.balance.pill` | Balance | ቀሪ ሂሳብ | ☐ |
| `dashboard.profit.pill` | Profit | ትርፍ | ☐ |
| `dashboard.profit.unavailable` | Not yet available | እስካሁን አይገኝም | ☐ |
| `dashboard.service.data` | Data | ዳታ | ☐ |
| `dashboard.service.electricity` | Electricity | ኤሌክትሪክ | ☐ |
| `dashboard.service.account` | Account | መለያ | ☐ |
| `dashboard.service.water` | Water | ውሃ | ☐ |
| `dashboard.service.dstv` | DStv | ዲኤስቲቪ | ☐ |
| `dashboard.service.telecom` | Telecom bill | የቴሌኮም ክፍያ | ☐ |
| `dashboard.service.traffic` | Traffic | ትራፊክ | ☐ |
| `dashboard.service.lottery` | Lottery | ሎተሪ | ☐ |
| `dashboard.service.tickets` | Tickets | ትኬቶች | ☐ |
| `dashboard.service.fuel` | Fuel | ነዳጅ | ☐ |
| `dashboard.service.internet` | Internet | ኢንተርኔት | ☐ |
| `dashboard.service.school` | School fees | የትምህርት ክፍያ | ☐ |
| `dashboard.service.insurance` | Insurance | መድን | ☐ |
| `dashboard.service.govfees` | Government fees | የመንግሥት ክፍያዎች | ☐ |
| `dashboard.nav.reprint` | Re-print | እንደገና አትም | ☐ |
| `dashboard.coming_soon.message` | Coming soon — this service is not active in training. | በቅርቡ ይመጣል — ይህ አገልግሎት በልምምድ ውስጥ አልነቃም። | ☐ |
| `dashboard.nav.prepaid` | Prepaid | ቅድመ ክፍያ | ☐ |
| `dashboard.nav.payments` | Payments | ክፍያዎች | ☐ |
| `dashboard.back_to_launcher` | Telga launcher | የቴልጋ ማስጀመሪያ | ☐ |

## Telga Pay (UI-only training simulator)

| Key | English (source) | Amharic (draft) | Review |
|---|---|---|---|
| `pay.banner` | Training card-payment simulator — no real processor connected. | የልምምድ የካርድ ክፍያ አስመሳይ — እውነተኛ አስተናጋጅ አልተገናኘም። | ☐ **priority** |
| `pay.no_transactions` | No Telga Pay transactions recorded in training. | በልምምድ ውስጥ ምንም የቴልጋ ፔይ ግብይት አልተመዘገበም። | ☐ |
| `pay.todays_sales_label` | Today's Telga sales | የዛሬው የቴልጋ ሽያጭ | ☐ |
| `pay.transactions_label` | Transaction(s) | ግብይት(ቶች) | ☐ |
| `pay.purchase.label` | Purchase | ግዢ | ☐ |
| `pay.cashback.label` | Cashback | ካሽባክ | ☐ |
| `pay.amount.label` | Amount | መጠን | ☐ |
| `pay.note.label` | Add Note | ማስታወሻ ጨምር | ☐ |
| `pay.pay_now` | Pay Now | አሁን ክፈል | ☐ |
| `pay.card.prompt` | Please Insert, Swipe or Tap Card | እባክዎ ካርድ ያስገቡ፣ ያንሸራትቱ ወይም ይንኩ | ☐ |
| `pay.card.tap` | Tap / Contactless | ንካ / ንክኪ የሌለው | ☐ |
| `pay.card.insert` | Insert / Chip | አስገባ / ቺፕ | ☐ |
| `pay.card.swipe` | Swipe | ማንሸራተት | ☐ |
| `pay.card.example_notice` | Visa and Mastercard shown as training examples only. No real card network is connected. | ቪዛ እና ማስተርካርድ የልምምድ ምሳሌዎች ብቻ ናቸው። ምንም እውነተኛ የካርድ አውታረ መረብ አልተገናኘም። | ☐ **priority** |
| `pay.outcome.approved` | Training simulation only — no real payment was processed. | የልምምድ አስመሳይ ብቻ — ምንም እውነተኛ ክፍያ አልተከናወነም። | ☐ **priority** |
| `pay.outcome.declined` | Declined — insufficient simulated funds. No payment was made. | ተቀባይነት አላገኘም — በቂ የልምምድ ገንዘብ የለም። ምንም ክፍያ አልተፈጸመም። | ☐ |
| `pay.outcome.read_error` | Card could not be read. Try again or choose another method. | ካርዱ ሊነበብ አልቻለም። እንደገና ይሞክሩ ወይም ሌላ ዘዴ ይምረጡ። | ☐ |
| `pay.outcome.cancelled` | Cancelled. No payment was made. | ተሰርዟል። ምንም ክፍያ አልተፈጸመም። | ☐ |
| `pay.card.practice_heading` | Practise a different training result | የተለየ የልምምድ ውጤት ይለማመዱ | ☐ |
| `pay.card.practice_declined` | Declined | ተቀባይነት አላገኘም | ☐ |
| `pay.card.practice_read_error` | Card read error | ካርድ ንባብ ስህተት | ☐ |
| `pay.card.practice_cancelled` | Cancelled | ተሰርዟል | ☐ |
| `pay.retry` | Try again | እንደገና ይሞክሩ | ☐ |
| `pay.deposit.label` | Add balance | ቀሪ ሂሳብ ጨምር | ☐ |
| `pay.deposit.heading` | Add training balance | የልምምድ ቀሪ ሂሳብ ጨምር | ☐ |
| `pay.deposit.prompt` | How much simulated balance do you want to add? | ምን ያህል የልምምድ ቀሪ ሂሳብ መጨመር ይፈልጋሉ? | ☐ |
| `pay.deposit.confirm` | Add to balance | ወደ ቀሪ ሂሳብ ጨምር | ☐ |
| `pay.deposit.notice` | Training only. This adds simulated balance so airtime sales can be practised. No real card is read and no real money moves. | ለልምምድ ብቻ። ይህ የአየር ሰዓት ሽያጭ ለመለማመድ የተመሰለ ቀሪ ሂሳብ ይጨምራል። እውነተኛ ካርድ አይነበብም እና እውነተኛ ገንዘብ አይንቀሳቀስም። | ☐ |
| `pay.deposit.credited` | Simulated balance added. | የተመሰለ ቀሪ ሂሳብ ተጨምሯል። | ☐ |
| `pay.deposit.invalid` | Enter a valid amount to add. | ለመጨመር ትክክለኛ መጠን ያስገቡ። | ☐ |
| `pay.deposit.slip_title` | Telga Pay deposit slip | የቴልጋ ፔይ ተቀማጭ ደረሰኝ | ☐ |
| `pay.deposit.method` | Card method | የካርድ ዘዴ | ☐ |
| `settings.tile.label` | Settings | ቅንብሮች | ☐ |
| `settings.heading` | Slip and training settings | የደረሰኝ እና የልምምድ ቅንብሮች | ☐ |
| `settings.slip_size.label` | Slip width | የደረሰኝ ስፋት | ☐ |
| `settings.slip_size.58` | 58 mm (narrow roll) | 58 ሚሜ (ጠባብ ጥቅል) | ☐ |
| `settings.slip_size.80` | 80 mm (wide roll) | 80 ሚሜ (ሰፊ ጥቅል) | ☐ |
| `settings.advert.label` | Advertisement line on the slip | በደረሰኙ ላይ የሚታተም የማስታወቂያ መስመር | ☐ |
| `settings.advert.hint` | Printed at the foot of every slip. Leave empty for none. | በእያንዳንዱ ደረሰኝ ግርጌ ይታተማል። ምንም ካልፈለጉ ባዶ ይተዉት። | ☐ |
| `settings.profit.label` | Training profit percentage | የልምምድ ትርፍ መቶኛ | ☐ |
| `settings.profit.hint` | Training figure only. It is not a negotiated commission and not a production rate. | የልምምድ አኃዝ ብቻ። የተደራደረ ኮሚሽን አይደለም እና የምርት ተመን አይደለም። | ☐ |
| `settings.profit.invalid` | Enter a percentage between 0 and 100. | ከ0 እስከ 100 ያለ መቶኛ ያስገቡ። | ☐ |
| `settings.save` | Save settings | ቅንብሮችን አስቀምጥ | ☐ |
| `settings.saved` | Settings saved. | ቅንብሮች ተቀምጠዋል። | ☐ |
| `settings.permission_denied` | Only the shop owner can change these settings. | እነዚህን ቅንብሮች መቀየር የሚችለው የሱቁ ባለቤት ብቻ ነው። | ☐ |
| `settings.signout` | Sign out completely | ሙሉ በሙሉ ውጣ | ☐ |
| `settings.signout.confirm` | Sign out completely? This machine will ask for all your sign-in details again. | ሙሉ በሙሉ ይውጡ? ይህ መሣሪያ ሁሉንም የመግቢያ መረጃዎችዎን እንደገና ይጠይቃል። | ☐ |
| `settings.signout.hint` | Signing out here clears the device, the device key and the operator. An idle timeout asks only for the PIN. | እዚህ መውጣት መሣሪያውን፣ የመሣሪያ ቁልፉንና ኦፕሬተሩን ያጸዳል። የእንቅስቃሴ-አልባ ጊዜ ማብቃት ፒኑን ብቻ ይጠይቃል። | ☐ |
| `receipt.training_notice` | TRAINING — NO REAL VALUE | ልምምድ — እውነተኛ ዋጋ የለውም | ☐ |

## The gap the POS renders around

Twenty-seven keys have **no Amharic at all**: the twenty-six `screen.*` titles and
`support.response.notice`. They are absent rather than machine-translated, because an unreviewed
guess that looks finished is worse than a visible gap.

`translate()` in `@telga/localization` falls back to English **and reports that it did**, so a
screen marks the text as untranslated rather than pretending. `tests/ui/localization.test.ts`
pins the exact missing set and the coverage count, so adding or removing a translation is a
deliberate change rather than a silent one — and it fails if the tables here and in
[[English Strings]] drift from the code.

An Amharic screen also renders `REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION` on the page,
not only in this note. See [[Merchant POS Screens]].

## Review procedure

1. A named native Amharic speaker reviews every row and ticks its box.
2. Priority order: pending and do-not-retry strings, then no-charge strings, then balances, then the rest.
3. The reviewer checks **register** (professional but plain, as a shop owner speaks), **terminology consistency** (the same Amharic word for "balance" everywhere), and **truthfulness** (no Amharic string claiming more certainty than its English source).
4. Sign-off is recorded in [[Decision Log]] with the reviewer's name and date.
5. Until then, `decision_status` on this note stays `pending` and the strings stay out of any production build.

## Known open questions for the reviewer

- **"Airtime"** — is አየር ሰዓት the term shop owners actually use at the counter, or is a borrowed term more natural in practice?
- **"Under review"** — በምርመራ ላይ may read as an *investigation of the merchant*. A phrasing that clearly means *we are checking with the provider* would be safer.
- **Formality** — drafts use the polite form (ይምረጡ, ያረጋግጡ). Confirm this suits merchant-facing POS copy.
- **Numerals** — amounts and IDs stay in Latin digits per [[Design System]]. Confirm this matches merchant expectation.

## Register as Telga member (D138)

**DRAFT — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION**, like every other
Amharic string here. The English note's wording rule applies unchanged: none of
these may read as *"your account has been created"*.

| Key | English | Amharic |
|---|---|---|
| `screen.register` | Register as Telga member | እንደ ተልጋ አባል ይመዝገቡ |
| `register.heading` | Register your shop with Telga | ሱቅዎን በተልጋ ያስመዝግቡ |
| `register.intro` | Fill this in and Telga will review it. Approval is not automatic, and no account is created yet. If your shop is approved, Telga will contact you with your sign-in details. | ይህንን ይሙሉ፤ ተልጋ ይመረምረዋል። ፈቃድ በራሱ አይሰጥም፤ እስካሁን ምንም መለያ አልተፈጠረም። ሱቅዎ ከተፈቀደ ተልጋ የመግቢያ መረጃዎን ይልክልዎታል። |
| `register.legal_name` | Business name | የንግድ ስም |
| `register.legal_name.hint` | Exactly as it appears on your trade licence. | በንግድ ፈቃድዎ ላይ እንደተጻፈው በትክክል። |
| `register.owner_name` | Owner full name | የባለቤቱ ሙሉ ስም |
| `register.phone` | Phone number | የስልክ ቁጥር |
| `register.phone.hint` | Telga will call this number about your application. | ተልጋ ስለ ማመልከቻዎ በዚህ ቁጥር ይደውላል። |
| `register.email` | Email (optional) | ኢሜይል (አማራጭ) |
| `register.email.hint` | Leave blank if you do not use email. | ኢሜይል ካልተጠቀሙ ባዶ ይተዉት። |
| `register.address` | Shop address | የሱቅ አድራሻ |
| `register.locality` | Town or sub-city | ከተማ ወይም ክፍለ ከተማ |
| `register.documents` | Your documents | ሰነዶችዎ |
| `register.documents.hint` | Enter the number printed on each document. Do not send photographs here — Telga will check the originals with you. | በእያንዳንዱ ሰነድ ላይ የተጻፈውን ቁጥር ያስገቡ። እዚህ ፎቶ አይላኩ — ተልጋ ዋናዎቹን ሰነዶች ከእርስዎ ጋር ያረጋግጣል። |
| `register.trade_licence` | Trade licence number | የንግድ ፈቃድ ቁጥር |
| `register.trade_licence_expiry` | Trade licence expiry date | የንግድ ፈቃድ የሚያበቃበት ቀን |
| `register.tin` | TIN | የግብር መለያ ቁጥር (TIN) |
| `register.photo_id` | Owner ID number | የባለቤቱ መታወቂያ ቁጥር |
| `register.photo_id.hint` | National ID, passport or driving licence. | ብሔራዊ መታወቂያ፣ ፓስፖርት ወይም የመንጃ ፈቃድ። |
| `register.submit` | Send for review | ለምርመራ ላክ |
| `register.have_account` | Already registered? Sign in | ቀድሞ ተመዝግበዋል? ይግቡ |
| `register.submitted.heading` | Sent to Telga for review | ለተልጋ ምርመራ ተልኳል |
| `register.submitted.reference` | Your reference number — write it down: | የማጣቀሻ ቁጥርዎ — ይመዝግቡት፦ |
| `register.submitted.next` | A member of Telga staff will check your details and contact you on the number you gave. Keep your original documents ready. | የተልጋ ሠራተኛ መረጃዎን አረጋግጦ በሰጡት ቁጥር ይደውልልዎታል። ዋና ሰነዶችዎን ዝግጁ ያድርጉ። |
| `register.submitted.no_account` | There is nothing to sign in to yet. Your sign-in details are issued only if your shop is approved. | እስካሁን የሚገቡበት መለያ የለም። የመግቢያ መረጃዎ የሚሰጠው ሱቅዎ ሲፈቀድ ብቻ ነው። |
| `login.register_cta` | Register as Telga member | እንደ ተልጋ አባል ይመዝገቡ |

## Activate this device (D138)

**DRAFT — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION.**

| Key | English | Amharic |
|---|---|---|
| `screen.activate` | Activate this device | ይህን መሣሪያ ያግብሩ |
| `activate.heading` | Activate this machine | ይህን መሣሪያ ያግብሩ |
| `activate.intro` | Telga gives each machine an activation code, valid for one hour and usable once. Enter it with the device ID Telga gave you. | ተልጋ ለእያንዳንዱ መሣሪያ የማግበሪያ ኮድ ይሰጣል፤ ለአንድ ሰዓት ብቻ የሚሠራ እና አንድ ጊዜ የሚያገለግል። ተልጋ ከሰጠዎት የመሣሪያ መለያ ጋር ያስገቡት። |
| `activate.device` | Device ID | የመሣሪያ መለያ |
| `activate.code` | Activation code | የማግበሪያ ኮድ |
| `activate.code.hint` | Groups of five letters and numbers. Case does not matter. | በአምስት ፊደላትና ቁጥሮች ተከፍሎ። ትልቅ ወይም ትንሽ ፊደል ችግር የለውም። |
| `activate.submit` | Activate | አግብር |
| `activate.done.heading` | This machine is activated | ይህ መሣሪያ ተግብሯል |
| `activate.done.key` | Device key — shown once. Write it down now: | የመሣሪያ ቁልፍ — አንድ ጊዜ ብቻ ይታያል። አሁን ይመዝግቡት፦ |
| `activate.done.warning` | Telga keeps only a scrambled copy and can never show this again. If it is lost, ask Telga for a new activation code. | ተልጋ የተመሰጠረ ቅጂ ብቻ ነው የሚይዘው፤ ዳግም ሊያሳይዎት አይችልም። ከጠፋ ከተልጋ አዲስ የማግበሪያ ኮድ ይጠይቁ። |
| `login.activate_cta` | New machine? Activate it | አዲስ መሣሪያ? ያግብሩት |

## Printing (D140)

**DRAFT — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION.**

| Key | English | Amharic |
|---|---|---|
| `receipt.print` | Print receipt | ደረሰኝ አትም |
| `receipt.print.notice` | Printing uses this device’s own printer. Every slip is marked TRAINING — NO REAL VALUE. | ማተሚያው የዚህ መሣሪያ ነው። እያንዳንዱ ደረሰኝ «TRAINING — NO REAL VALUE» የሚል ምልክት አለው። |

## Reporting a problem with a sale (D150)

**DRAFT — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION.**

| Key | English | Amharic |
|---|---|---|
| `complaint.title` | Report a problem | ችግር ያሳውቁ |
| `complaint.intro` | Tell Telga what went wrong with a sale. Give the transaction number from the receipt and describe the problem in your own words. | በሽያጭ ላይ ምን እንደተፈጠረ ለተልጋ ይንገሩ። ከደረሰኙ ላይ የግብይት ቁጥሩን ያስገቡና ችግሩን በራስዎ ቃል ይግለጹ። |
| `complaint.transaction` | Transaction number | የግብይት ቁጥር |
| `complaint.transaction.hint` | Printed on the receipt. Ask the customer for their copy if you do not have yours. | በደረሰኙ ላይ ተጽፏል። የእርስዎ ከሌለ የደንበኛውን ቅጂ ይጠይቁ። |
| `complaint.description` | What went wrong | ምን ተፈጠረ |
| `complaint.submit` | Send to Telga | ወደ ተልጋ ላክ |
| `complaint.promise` | Telga will check this and give you an answer. If the money is protected while it is checked, Telga will say so — nothing is refunded until the outcome is known. | ተልጋ ይህንን አረጋግጦ መልስ ይሰጥዎታል። በሚጣራበት ጊዜ ገንዘቡ የተጠበቀ ከሆነ ተልጋ ይነግርዎታል — ውጤቱ እስኪታወቅ ድረስ ምንም አይመለስም። |
| `complaint.sent.heading` | Sent to Telga | ወደ ተልጋ ተልኳል |
| `complaint.sent.reference` | Your case number — quote it when you call: | የጉዳይዎ ቁጥር — ሲደውሉ ይጥቀሱት፦ |
| `complaint.sent.next` | Telga is checking the sale and the provider. You will be told the outcome. Keep serving customers as normal. | ተልጋ ሽያጩንና አቅራቢውን እያጣራ ነው። ውጤቱ ይነገርዎታል። እንደተለመደው ደንበኞችን ማገልገልዎን ይቀጥሉ። |

## Asking for a reversal (D151)

**DRAFT — REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION.**

| Key | English | Amharic |
|---|---|---|
| `reverse.title` | Ask Telga to reverse a sale | ተልጋ ሽያጭ እንዲመልስ ይጠይቁ |
| `reverse.intro` | If a customer handed back a token they could not use, ask Telga to return the money. Telga checks the sale first — the money is not returned until somebody has looked. | ደንበኛ መጠቀም ያልቻለውን ቶከን ከመለሰ፣ ተልጋ ገንዘቡን እንዲመልስ ይጠይቁ። ተልጋ መጀመሪያ ሽያጩን ያረጋግጣል — ሰው እስኪያየው ድረስ ገንዘቡ አይመለስም። |
| `reverse.transaction` | Transaction number | የግብይት ቁጥር |
| `reverse.reason` | Why it should be reversed | ለምን መመለስ እንዳለበት |
| `reverse.reason.hint` | For example: customer returned the token unused. | ለምሳሌ፦ ደንበኛው ቶከኑን ሳይጠቀም መልሷል። |
| `reverse.submit` | Send request | ጥያቄ ላክ |
| `reverse.sent.heading` | Request sent to Telga | ጥያቄው ወደ ተልጋ ተልኳል |
| `reverse.sent.reference` | Your request number: | የጥያቄዎ ቁጥር፦ |
| `reverse.sent.next` | Telga will check whether the value reached the customer. Nothing is returned to your balance until that check is done. | ተልጋ ዋጋው ደንበኛው ጋር መድረሱን ያረጋግጣል። ያ እስኪጠናቀቅ ድረስ ወደ ቀሪ ሂሳብዎ ምንም አይመለስም። |
| `reverse.pending.notice` | A request for this sale is already with Telga. Do not send another. | ለዚህ ሽያጭ ጥያቄ አስቀድሞ ወደ ተልጋ ተልኳል። ሌላ አይላኩ። |

## Related

- [[English Strings]]
- [[Design System]]
- [[Screen Inventory]]
- [[Decision Log]]

---
Back to [[00 Home]]
