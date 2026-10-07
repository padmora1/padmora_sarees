-- A colour's Final selling price is generated (Final CP + margin, rounded to the nearest 10 rupees) but the admin may type their own.
-- price_manual remembers that, so "Update prices of existing sarees" never overwrites a price someone set by hand.
alter table product_variants add column if not exists price_manual boolean not null default false;
