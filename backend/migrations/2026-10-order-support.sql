-- Order support:
--  * contact_messages.order_id: the order a "Order Support" / "Returns & Exchange" message is about (the admin Messages screen links to it).
--  * orders.extra_inquiries / extra_inquiry_until: extra order inquiries an admin has allowed for ONE order (e.g. after the customer wrote
--    in through Contact Us). Each credit lets the customer send one more inquiry before extra_inquiry_until; it is used up when they send it.
alter table public.contact_messages add column if not exists order_id text;
alter table public.orders add column if not exists extra_inquiries integer not null default 0;
alter table public.orders add column if not exists extra_inquiry_until timestamptz;
