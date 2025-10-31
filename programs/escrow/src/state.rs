use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Offer {
    // offer identifier
    pub id: u64,
    // initiator of the offer
    pub maker: Pubkey,
    // token offered by the maker
    pub token_mint_a: Pubkey,
    // token(owned by taker) wanted by the maker
    pub token_mint_b: Pubkey,
    // amount of token b wanted by the maker
    pub token_b_wanted_amount: u64,
    // cached bump to prevent recalculating it every time
    pub bump: u8,
}
