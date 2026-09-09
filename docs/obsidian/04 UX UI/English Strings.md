---
title: English Strings
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - localization
  - english
related:
  - "[[00 Home]]"
  - "[[Amharic Strings]]"
  - "[[Screen Inventory]]"
  - "[[Design System]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# English Strings

The English source of every merchant-facing string. **This is the authoritative wording** —
[[Amharic Strings]] translates from here, and no Amharic string may say more than its English
source claims.

Key format: `area.screen.element`.

## Merchant-critical terms

These twenty carry the most operational weight. A mistake here costs money or trust.

| Key | English |
|---|---|
| `sale.action.sell_airtime` | Sell airtime |
| `sale.amount.select` | Select amount |
| `sale.confirm.action` | Confirm sale |
| `status.processing` | Processing |
| `status.pending` | Transaction pending |
| `status.pending.do_not_retry` | Do not retry yet |
| `status.successful` | Transaction successful |
| `status.failed` | Transaction failed |
| `status.under_review` | Under review |
| `status.provider_unavailable` | Provider temporarily unavailable |
| `status.sales_unavailable` | Sales temporarily unavailable |
| `status.no_charge` | No charge was made |
| `balance.available` | Available balance |
| `balance.reserved` | Reserved balance |
| `balance.under_review` | Under review balance |
| `commission.net` | Net commission |
| `receipt.reprint` | Reprint receipt |
| `transaction.id` | Transaction ID |
| `support.contact` | Contact support |
| `mode.training` | Training mode — no real value |

## Full messages

| Key | English |
|---|---|
| `status.pending.message` | This transaction is still being checked. Do not retry yet. |
| `status.under_review.message` | This transaction is being reviewed. Your balance is protected while we check with the provider. |
| `status.failed.message` | This sale did not go through. No charge was made. |
| `status.provider_unavailable.message` | Airtime is temporarily unavailable from this provider. No charge was made. Other services are still working. |
| `status.offline.message` | Sales are temporarily unavailable. You can still view history, reports and support. |
| `receipt.reprint.notice` | This is a reprint. It is not a new sale. |
| `support.response.notice` | We will give you a first answer straight away and a final answer within 24 hours. |
| `funding.simulated.notice` | This is a simulated funding submission. No real money is involved. |

## Screen titles

| Key | English |
|---|---|
| `screen.login` | Sign in |
| `screen.home` | Home |
| `screen.provider_select` | Select network |
| `screen.amount_select` | Select amount |
| `screen.recipient` | Customer cellphone number |
| `screen.confirm` | Confirm sale |
| `screen.balance` | Balance |
| `screen.search` | Find transaction |
| `screen.details` | Transaction details |
| `screen.reports` | Reports |
| `screen.funding` | Add funds |
| `screen.support` | Support |
| `screen.admin_queue` | Review queue |
| `screen.menu` | Main menu |
| `screen.vouchers` | Vouchers |
| `screen.product_type` | Select product type |
| `screen.order_details` | Order details |
| `screen.pin_auth` | PIN authorization |
| `screen.voucher_result` | Training voucher result |
| `screen.launcher` | Telga |
| `statements.title` | Statement |
| `statements.from` | From |
| `statements.to` | To |
| `statements.apply` | Apply |
| `statements.clear` | Clear |
| `statements.sales` | Sales |
| `statements.gross` | Sold |
| `statements.profit` | Profit |
| `statements.reversals` | Reversed |
| `statements.total` | Total |
| `statements.note` | Profit is what was earned on each day. Moving profit into the selling balance is not a sale and is not subtracted here; a reversed sale is. |
| `screen.pay_settings` | Telga Pay settings |
| `pay.records.transactions_title` | Telga Pay transactions |
| `pay.records.statements_title` | Telga Pay statements |
| `pay.records.cards_not_stored` | Card attempts are not recorded. A simulated card moves no value, so nothing is written to the ledger for one. Training deposits are recorded, because they post a real balanced entry against the float. |
| `pay.records.empty` | Nothing recorded yet. |
| `pay.records.count` | Entries |
| `pay.settings.flag_card_note` | The card simulator. Nothing behind it reaches a bank. |
| `pay.settings.flag_accept_note` | Real card acceptance. Needs an acquirer and a licence. |
| `pay.settings.flag_deposit_note` | Simulated deposits into the training float. |
| `pay.settings.flag_cash_note` | Taking cash in or paying it out. Legal review required. |
| `pay.settings.intro` | These settings belong to Telga Pay. Slip width and business details are shared with Telga Vending and are set there. |
| `pay.settings.records` | Records |
| `pay.settings.transactions` | Card transactions |
| `pay.settings.statements` | Card statements |
| `pay.settings.cards` | Training cards |
| `pay.settings.cards_hint` | A reference sheet, not a setting. These cards are fixed in the simulator so each outcome can be practised on demand. |
| `pay.settings.flags` | What is switched on |
| `pay.settings.flag_on` | On |
| `pay.settings.flag_off` | Off |
| `pay.settings.slips` | Slips |
| `pay.settings.slips_note` | Slip width, the advertisement line and the business details print on every Telga slip, card or voucher. They are one shop identity and are set in Telga Vending settings. |
| `pay.settings.account` | Signed in as |
| `pay.settings.operator` | Operator |
| `pay.settings.device` | Device |
| `pay.settings.merchant` | Merchant |
| `settings.slip_size` | Slip width |
| `screen.launcher_apps` | Choose Telga service |
| `screen.dashboard` | Telga dashboard |
| `screen.coming_soon` | Coming soon |
| `screen.pay_entry` | Telga Pay |
| `screen.pay_amount` | Enter amount |
| `screen.pay_card` | Card simulator |
| `screen.pay_result` | Payment result |

## Training voucher flow (simulated)

Screen-sequence labels for the training-only voucher flow (`04 UX UI/Voucher Purchase Flow.md`).
Networks shown to the operator are clearly-labelled simulated placeholders — no real telecom
network is integrated. Currency stays ETB throughout; nothing here introduces another currency.

| Key | English |
|---|---|
| `voucher.action.print` | PRINT |
| `voucher.action.cancel` | CANCEL |
| `voucher.action.back` | BACK |
| `voucher.action.continue` | Continue |
| `voucher.product.airtime` | Airtime |
| `voucher.data.unavailable` | Not available in training |
| `voucher.pin.prompt` | Enter PIN to buy training voucher |
| `voucher.pin.clear` | Clear |
| `voucher.pin.confirm` | OK / CONFIRM |
| `voucher.result.no_printer` | Training voucher shown on screen — no physical printer configured. |
| `voucher.result.preview_notice` | Preview only. PIN verification and voucher creation are not yet active — no training voucher was recorded. |
| `voucher.result.new_sale` | New sale |
| `voucher.amount.invalid` | Select a valid amount for this network. |
| `sale.amount.select_placeholder` | Select airtime amount |
| `sale.amount.custom` | Custom amount |
| `sale.amount.custom_label` | Amount in birr |
| `sale.amount.custom.below_min` | That amount is below the training minimum. |
| `sale.amount.custom.above_max` | That amount is above the training maximum. |
| `sale.amount.custom.not_multiple` | Enter a whole number of birr. |
| `sale.amount.custom.not_a_number` | Enter a valid amount. |
| `voucher.pin.heading` | Confirm transaction PIN |
| `voucher.product.topup` | Direct top-up |
| `voucher.summary.merchant` | Training merchant |
| `voucher.summary.amount` | Amount |
| `voucher.summary.total` | Total |
| `voucher.summary.profit` | Your profit |
| `voucher.summary.recipient` | Phone number |
| `topup.tile.label` | Top up a phone |
| `topup.phone.label` | Customer phone number |
| `topup.phone.hint` | The number the airtime is sent to. |
| `topup.phone.invalid` | Enter a valid phone number. |
| `topup.phone.required` | A phone number is required for a direct top-up. |
| `nav.main` | Main |
| `card.read` | Read card |
| `card.declined_heading` | Not approved |
| `card.no_response_heading` | No answer from the bank |
| `card.try_again` | Ask the customer to try again with the same card. |
| `card.number` | Card |
| `card.scheme` | Type |
| `card.entry_mode` | Read by |
| `card.simulator_title` | Training card — a real reader supplies this itself |
| `settings.shift.hint` | A shift records when an operator started and finished. It holds no money of its own. |
| `settings.shift.statement` | Statement for this shift |
| `settings.account.operator` | Operator |
| `settings.account.device` | Device |
| `settings.account.merchant` | Merchant |
| `settings.account.hint` | Telga signs in with an operator ID, a PIN and a device key — there is no password. Use Change PIN below. |
| `outage.heading` | Service unavailable |
| `outage.unavailable` | not available right now |
| `outage.no_charge` | Nothing was charged. No sale was made and no commission was earned. |
| `outage.last_checked` | Last checked |
| `outage.still_available` | Still available |
| `offline.heading` | Telga is not reachable |
| `offline.no_sales` | No new sales can be made until the connection returns. |
| `offline.no_offline_vending` | Selling offline is not allowed. Do not take money for a sale this machine cannot complete. |
| `offline.last_seen` | Last connected |
| `offline.still_available` | What still works |
| `dashboard.low_balance` | Your selling balance is running low. Top up before it runs out. |
| `statements.admin_only` | Statements are set to owner-only. Ask the shop owner to view them. |
| `card.decline.insufficient_funds` | Not enough money on the card. Nothing was charged. |
| `card.decline.wrong_pin` | Wrong card PIN. Ask the customer to try again. |
| `card.decline.expired` | That card has expired. Nothing was charged. |
| `card.decline.blocked` | That card is blocked. Nothing was charged. |
| `card.decline.limit` | That amount is over the card limit. Nothing was charged. |
| `card.decline.issuer` | The bank did not answer. Try again in a moment. |
| `card.decline.generic` | The card was declined. Nothing was charged. |
| `card.no_response` | The bank has not answered. Do not retry and do not hand over goods yet — check the transaction before continuing. |
| `card.not_read` | The card was not read. Ask the customer to present it again. |
| `card.no_reader` | No card reader is connected to this device. |
| `card.present` | Tap, insert or swipe the card |
| `card.approved` | Approved |
| `card.reference` | Authorisation |
| `receipt.lookup_title` | Shop copy — lookup |
| `receipt.lookup_note` | Keep this to find the sale again. |
| `menu.lock` | Lock |
| `menu.manage` | Manage |
| `lock.heading` | Screen locked |
| `lock.pin_label` | Enter your PIN to unlock |
| `lock.unlock` | Unlock |
| `lock.wrong` | That PIN is not correct. The screen stays locked. |
| `menu.open` | Open menu |
| `menu.statements` | Statements |
| `menu.end_shift` | End shift |
| `menu.customers` | Customer list |
| `menu.learning` | Learning |
| `menu.settings` | Settings |
| `menu.help` | Help |
| `menu.logout` | Log out |
| `screen.help` | Telga support |
| `screen.learning` | How to use Telga |
| `screen.customers` | Customer list |
| `screen.end_shift` | End shift |
| `help.intro` | Telga support, for anything this machine cannot answer. |
| `help.phone` | Phone |
| `help.email` | Email |
| `help.hours` | Hours |
| `help.address` | Address |
| `help.reference_hint` | Have the transaction reference from the slip ready — it is the fastest way to find a sale. |
| `learning.intro` | Each step below is one thing to try on this machine. Work through them in order. |
| `customers.empty` | No saved customers yet. |
| `customers.name` | Customer name |
| `customers.phone` | Phone number |
| `customers.add` | Save customer |
| `customers.privacy` | Saved numbers are stored masked, the same way a slip prints them. |
| `customers.invalid` | Enter a name and a valid phone number. |
| `shift.open_since` | Shift open since |
| `shift.none_open` | No shift is open. |
| `shift.end` | End shift |
| `shift.end_confirm` | End this shift? |
| `shift.ended` | Shift ended. |
| `settings.section.shift` | Shift settings |
| `settings.section.account` | Account settings |
| `settings.section.app` | In-app settings |
| `settings.section.admin` | Admin only |
| `settings.section.security` | Security |
| `settings.section.about` | About and policies |
| `settings.toggle.sound` | Play sound |
| `settings.toggle.hide_balance` | Hide Telga balance |
| `settings.toggle.low_balance` | Alert me when balance is low |
| `settings.toggle.statements_admin` | Statements viewable by admin only |
| `settings.toggle.print_barcode` | Print barcode on slips |
| `settings.toggle.print_lookup` | Print lookup slip |
| `settings.toggle.pin_lock` | Require PIN to unlock |
| `settings.lock_seconds` | Lock the screen after (seconds) |
| `settings.account.phone` | Change phone number |
| `settings.account.password` | Change password |
| `settings.account.details` | Change your details |
| `settings.about.telga` | About Telga |
| `settings.about.terms` | Terms and conditions |
| `settings.about.privacy` | Privacy policy |
| `settings.about.cookies` | Cookie policy |
| `settings.back` | Back |
| `balance.top_up` | Top up your balance |
| `balance.top_up.open` | Add to balance |
| `balance.top_up.bank` | Bank deposit |
| `balance.top_up.pay` | Telga Pay balance |
| `balance.top_up.profit` | Profit |
| `screen.profit_transfer` | Move profit to selling balance |
| `profit.transfer.action` | Move to selling balance |
| `profit.transfer.available` | Profit available to move |
| `profit.transfer.amount_label` | Amount in birr |
| `profit.transfer.amount_invalid` | Enter a whole number of birr, at least 1. |
| `profit.transfer.exceeds` | That is more than the profit you have. Nothing was moved. |
| `profit.transfer.confirm` | OK |
| `profit.transfer.done` | Moved to your selling balance. |
| `profit.transfer.remaining` | Profit remaining |
| `profit.transfer.new_balance` | New selling balance |
| `profit.transfer.none` | There is no profit to move yet. |
| `settings.pin.heading` | Change transaction PIN |
| `settings.pin.current` | Current PIN |
| `settings.pin.new` | New PIN |
| `settings.pin.confirm` | Confirm new PIN |
| `settings.pin.save` | Change PIN |
| `settings.pin.changed` | Transaction PIN changed. Use the new PIN from now on. |
| `settings.pin.wrong_current` | That current PIN is not correct. Nothing was changed. |
| `settings.pin.weak` | Choose a different six-digit PIN. Avoid 111111 or 123456. |
| `settings.pin.mismatch` | The two new PINs do not match. Nothing was changed. |
| `settings.business.heading` | Business details |
| `settings.business.hint` | Printed on every slip. Telga does not verify these. |
| `settings.business.name` | Business name |
| `settings.business.address` | Address |
| `settings.business.phone` | Shop phone number |
| `settings.business.tin` | TIN |
| `settings.business.licence` | Trade licence number |
| `settings.business.footer` | Closing line on the slip |
| `launcher.open_telga` | Tap Telga to open |
| `voucher.quantity.label` | How many vouchers |
| `voucher.quantity.invalid` | Choose between 1 and 20 vouchers. |
| `voucher.quantity.decrease` | One fewer |
| `voucher.quantity.increase` | One more |
| `voucher.summary.quantity` | Vouchers |
| `voucher.summary.each` | Price each |
| `receipt.slip.batch_position` | Voucher |
| `voucher.action.main` | MAIN |
| `voucher.action.main_confirm` | Leave this sale and go to the main screen? No voucher will be issued. |
| `voucher.product.data` | Data |
| `data.category.select` | Choose a data type |
| `data.package.select` | Choose a package |
| `data.column.volume` | Bundle |
| `data.column.validity` | Valid for |
| `data.phone.label` | Customer phone number |
| `data.phone.required` | A phone number is required for a data bundle. |
| `data.category.monthly` | Monthly |
| `data.category.weekly` | Weekly |
| `data.category.daily` | Daily |
| `data.category.hourly` | Hourly |
| `data.category.weekend` | Weekend |
| `data.category.all_access` | All-Access |
| `data.category.lte` | LTE |
| `data.category.social` | Social |
| `data.category.voice` | Voice |
| `receipt.slip.network_code` | Network |
| `receipt.slip.voucher_pin` | Voucher PIN |
| `receipt.slip.token_reference` | Token reference |
| `receipt.slip.dial_string` | To load, dial |
| `receipt.slip.simulated_code_notice` | SIMULATED CODE — will not load airtime |
| `voucher.error.insufficient_balance` | Insufficient training balance. No voucher was issued. |
| `voucher.error.order_expired` | This order expired before it was confirmed. No voucher was issued. |
| `voucher.error.order_not_open` | This order was already completed or cancelled. No voucher was issued. |
| `voucher.error.duplicate` | This voucher was already issued. It was not issued again. |
| `voucher.error.generic` | The voucher could not be completed. No voucher was issued. |
| `voucher.result.failed_title` | Voucher not issued |
| `voucher.action.back_to_vouchers` | Back to Vouchers |
| `voucher.action.home` | Home |
| `receipt.not_available` | No receipt is available for this transaction yet. |
| `receipt.slip.title` | Transaction slip |
| `receipt.slip.reprint_notice` | REPRINT — not a new sale |
| `receipt.action.close` | Close |
| `receipt.action.print` | Print |
| `receipt.print.failed` | Printing could not be completed. The transaction is unchanged. |
| `transactions.empty` | No transactions yet. |
| `transactions.column.datetime` | Date and time |
| `transactions.column.service` | Service |
| `transactions.column.amount` | Amount |
| `transactions.column.status` | Status |
| `transactions.column.reference` | Reference |
| `voucher.pin.wrong` | Incorrect transaction PIN. No voucher was issued. |
| `voucher.pin.locked` | Too many incorrect PIN attempts. Voucher authorization is locked for a few minutes. Your login is not affected. |

## Telga launcher and dashboard

| Key | English |
|---|---|
| `launcher.tile.telga.label` | TELGA |
| `launcher.tile.telga.subtitle` | Vending and merchant services |
| `launcher.tile.telgapay.label` | TELGA PAY |
| `launcher.tile.telgapay.subtitle` | Card-payment training simulator |
| `dashboard.balance.pill` | Balance |
| `dashboard.profit.pill` | Profit |
| `dashboard.profit.unavailable` | Not yet available |
| `dashboard.service.data` | Data |
| `dashboard.service.electricity` | Electricity |
| `dashboard.service.account` | Account |
| `dashboard.service.water` | Water |
| `dashboard.service.dstv` | DStv |
| `dashboard.service.telecom` | Telecom bill |
| `dashboard.service.traffic` | Traffic |
| `dashboard.service.lottery` | Lottery |
| `dashboard.service.tickets` | Tickets |
| `dashboard.service.fuel` | Fuel |
| `dashboard.service.internet` | Internet |
| `dashboard.service.school` | School fees |
| `dashboard.service.insurance` | Insurance |
| `dashboard.service.govfees` | Government fees |
| `dashboard.nav.reprint` | Re-print |
| `dashboard.coming_soon.message` | Coming soon — this service is not active in training. |
| `dashboard.nav.prepaid` | Prepaid |
| `dashboard.nav.payments` | Payments |
| `dashboard.back_to_launcher` | Telga launcher |

## Telga Pay (UI-only training simulator)

| Key | English |
|---|---|
| `pay.banner` | Training card-payment simulator — no real processor connected. |
| `pay.no_transactions` | No Telga Pay transactions recorded in training. |
| `pay.todays_sales_label` | Today's Telga sales |
| `pay.transactions_label` | Transaction(s) |
| `pay.purchase.label` | Purchase |
| `pay.cashback.label` | Cashback |
| `pay.amount.label` | Amount |
| `pay.note.label` | Add Note |
| `pay.pay_now` | Pay Now |
| `pay.card.prompt` | Please Insert, Swipe or Tap Card |
| `pay.card.tap` | Tap / Contactless |
| `pay.card.insert` | Insert / Chip |
| `pay.card.swipe` | Swipe |
| `pay.card.example_notice` | Visa and Mastercard shown as training examples only. No real card network is connected. |
| `pay.outcome.approved` | Training simulation only — no real payment was processed. |
| `pay.outcome.declined` | Declined — insufficient simulated funds. No payment was made. |
| `pay.outcome.read_error` | Card could not be read. Try again or choose another method. |
| `pay.outcome.cancelled` | Cancelled. No payment was made. |
| `pay.card.practice_heading` | Practise a different training result |
| `pay.card.practice_declined` | Declined |
| `pay.card.practice_read_error` | Card read error |
| `pay.card.practice_cancelled` | Cancelled |
| `pay.retry` | Try again |
| `pay.deposit.label` | Add balance |
| `pay.deposit.heading` | Add training balance |
| `pay.deposit.prompt` | How much simulated balance do you want to add? |
| `pay.deposit.confirm` | Add to balance |
| `pay.deposit.notice` | Training only. This adds simulated balance so airtime sales can be practised. No real card is read and no real money moves. |
| `pay.deposit.credited` | Simulated balance added. |
| `pay.deposit.invalid` | Enter a valid amount to add. |
| `pay.deposit.slip_title` | Telga Pay deposit slip |
| `pay.deposit.method` | Card method |
| `settings.tile.label` | Settings |
| `settings.heading` | Slip and training settings |
| `settings.slip_size.label` | Slip width |
| `settings.slip_size.58` | 58 mm (narrow roll) |
| `settings.slip_size.80` | 80 mm (wide roll) |
| `settings.advert.label` | Advertisement line on the slip |
| `settings.advert.hint` | Printed at the foot of every slip. Leave empty for none. |
| `settings.profit.label` | Training profit percentage |
| `settings.profit.hint` | Training figure only. It is not a negotiated commission and not a production rate. |
| `settings.profit.invalid` | Enter a percentage between 0 and 100. |
| `settings.save` | Save settings |
| `settings.saved` | Settings saved. |
| `settings.permission_denied` | Only the shop owner can change these settings. |
| `settings.signout` | Sign out completely |
| `settings.signout.confirm` | Sign out completely? This machine will ask for all your sign-in details again. |
| `settings.signout.hint` | Signing out here clears the device, the device key and the operator. An idle timeout asks only for the PIN. |
| `receipt.training_notice` | TRAINING — NO REAL VALUE |

## Errors

| Key | English |
|---|---|
| `error.validation.recipient` | Check the phone number and try again. |
| `error.balance.insufficient` | Not enough available balance for this sale. |
| `error.permission.denied` | Your role does not allow this action. |
| `error.session.expired` | Your session has ended. Sign in again. Nothing was lost. |
| `error.printer.failed` | The receipt did not print. The sale is complete — you can reprint it. |
| `error.duplicate.blocked` | This sale is already in progress. Do not start it again. |
| `error.network_unavailable` | Telga could not be reached. The result of this sale is not known yet — do not retry it. |

## Register as Telga member (D138)

The app's own registration form and its confirmation. **Nothing here may read as
a sign-up.** The applicant is asking to be considered; a shop that believes it
has an account and finds out days later that it has a queue position is a
failure of these strings, not of the workflow.

| Key | English |
|---|---|
| `screen.register` | Register as Telga member |
| `register.heading` | Register your shop with Telga |
| `register.intro` | Fill this in and Telga will review it. Approval is not automatic, and no account is created yet. If your shop is approved, Telga will contact you with your sign-in details. |
| `register.legal_name` | Business name |
| `register.legal_name.hint` | Exactly as it appears on your trade licence. |
| `register.owner_name` | Owner full name |
| `register.phone` | Phone number |
| `register.phone.hint` | Telga will call this number about your application. |
| `register.email` | Email (optional) |
| `register.email.hint` | Leave blank if you do not use email. |
| `register.address` | Shop address |
| `register.locality` | Town or sub-city |
| `register.documents` | Your documents |
| `register.documents.hint` | Enter the number printed on each document. Do not send photographs here — Telga will check the originals with you. |
| `register.trade_licence` | Trade licence number |
| `register.trade_licence_expiry` | Trade licence expiry date |
| `register.tin` | TIN |
| `register.photo_id` | Owner ID number |
| `register.photo_id.hint` | National ID, passport or driving licence. |
| `register.submit` | Send for review |
| `register.have_account` | Already registered? Sign in |
| `register.submitted.heading` | Sent to Telga for review |
| `register.submitted.reference` | Your reference number — write it down: |
| `register.submitted.next` | A member of Telga staff will check your details and contact you on the number you gave. Keep your original documents ready. |
| `register.submitted.no_account` | There is nothing to sign in to yet. Your sign-in details are issued only if your shop is approved. |
| `login.register_cta` | Register as Telga member |

## Activate this device (D138)

The code a person carried to the shop, exchanged for the key the machine keeps —
`CLAUDE.md` §18.2. **Nothing here may suggest the code is what signs the device
in afterwards.** It is not: it dies on use, and the key it produces is a
different secret that no human ever reads.

| Key | English |
|---|---|
| `screen.activate` | Activate this device |
| `activate.heading` | Activate this machine |
| `activate.intro` | Telga gives each machine an activation code, valid for one hour and usable once. Enter it with the device ID Telga gave you. |
| `activate.device` | Device ID |
| `activate.code` | Activation code |
| `activate.code.hint` | Groups of five letters and numbers. Case does not matter. |
| `activate.submit` | Activate |
| `activate.done.heading` | This machine is activated |
| `activate.done.key` | Device key — shown once. Write it down now: |
| `activate.done.warning` | Telga keeps only a scrambled copy and can never show this again. If it is lost, ask Telga for a new activation code. |
| `login.activate_cta` | New machine? Activate it |

## Printing (D140)

The slip screens' print action. **It must not promise a printer that is not
attached**: what Telga does is hand the slip to the device's own print stack,
and whether paper comes out depends on what that device is paired with.

| Key | English |
|---|---|
| `receipt.print` | Print receipt |
| `receipt.print.notice` | Printing uses this device’s own printer. Every slip is marked TRAINING — NO REAL VALUE. |

## Wording rules

1. Never promise speed. No "instant", "immediately", or "right away" about a provider outcome.
2. Never call an unknown outcome a failure. `PENDING` is *"still being checked"*, never *"failed"*.
3. Always say when no charge was made. Merchants assume the worst in silence.
4. Never blame the merchant for a provider fault.
5. Short sentences. A busy shop owner reads four words, not a paragraph.

## Related

- [[Amharic Strings]]
- [[Screen Inventory]]
- [[Receipt Specification]]

---
Back to [[00 Home]]
