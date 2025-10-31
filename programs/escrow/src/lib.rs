use anchor_lang::prelude::*;
use instructions::*;

pub mod instructions;
pub mod error;
pub mod state;
declare_id!("HBR5uPNamRBm2XmKW3qWzWvdgxVR2FnwTjBVLJxCdu4J");

#[program]
pub mod trust_escrow {
    use super::*;

    pub fn make_offer(ctx: Context<MakeOffer>, id: u64, token_a_offered_amount: u64, token_b_wanted_amount: u64) -> Result<()> {
        instructions::make_offer(ctx, id, token_a_offered_amount, token_b_wanted_amount)
    }

    pub fn take_offer(ctx: Context<TakeOffer>) -> Result<()> {
        instructions::take_offer(ctx)
    }
}
