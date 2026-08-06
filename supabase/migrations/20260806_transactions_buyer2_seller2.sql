-- Second buyer / second seller contact fields.
--
-- Deal Details previously only had one buyer_name/buyer_email/buyer_phone and
-- one seller_name/seller_email/seller_phone slot each — multi-person deals
-- ("Chelsea Linton, Thomas Linton") got crammed into a single free-text name
-- field with no way to capture a second person's email, so the email/
-- notification system had no real address to send transaction updates to for
-- anyone but the first party. Adds an explicit, additive "party 2" slot per
-- side, mirroring the existing lease_tenant1_*/lease_tenant2_* pattern
-- already in this table.
--
-- Backward compatible: existing rows keep their data in buyer_name/
-- buyer_email/buyer_phone/seller_name/seller_email/seller_phone (now
-- "Buyer 1"/"Seller 1" in the UI); the new *2_* columns default NULL until
-- an agent fills in a second party.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_name TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_email TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_phone TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_name TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_email TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_phone TEXT;
