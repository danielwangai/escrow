use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use crate::error::ErrorCode;
use crate::state::*;
use crate::instructions::shared::transfer_tokens;

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct MakeOffer<'info> {
    // Used to manage associated token accounts
    // ie where a wallet holds a specific type of token
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub token_program: Interface<'info, TokenInterface>,

    // solana's system program used to create accounts
    pub system_program: Program<'info, System>,

    #[account(mut)]
    // the account that is making the offer and paying for the transaction(signature) fees
    pub maker: Signer<'info>,


    #[account(mint::token_program = token_program)]
    pub token_mint_a: InterfaceAccount<'info, Mint>,

    #[account(mint::token_program = token_program)]
    pub token_mint_b: InterfaceAccount<'info, Mint>,

    #[account(
        mut, // mutable because we are going to deduct tokens from this account
        associated_token::mint = token_mint_a,
        associated_token::authority = maker,
        associated_token::token_program = token_program
    )]
    // token that maker is offering and put into vault
    pub maker_token_account_a: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, // offer must be unique
        payer = maker,
        space = Offer::DISCRIMINATOR.len() + Offer::INIT_SPACE,
        seeds = [b"offer", id.to_le_bytes().as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    #[account(
        init,
        payer = maker,
        associated_token::mint = token_mint_a,
        associated_token::authority = offer, // offer owns the vault data account
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

// maker proposes to trade token a for token b
// tokens are moved from maker's ATA to the vault
// details of the offer are saved to the offer account
pub fn make_offer(
    context: Context<MakeOffer>,
    id: u64, // unique offer identifier
    token_a_offered_amount: u64, // amount of token a offered by the maker
    token_b_wanted_amount: u64, // amount of token b wanted by the maker
) -> Result<()> {
    // amounts must be greater than 0
    require!(token_a_offered_amount > 0, ErrorCode::InvalidAmount);
    require!(token_b_wanted_amount > 0, ErrorCode::InvalidAmount);

    // token mints must be different so as not to trade token a for same token a from the taker
    require!(
        context.accounts.token_mint_a.key() != context.accounts.token_mint_b.key(),
        ErrorCode::InvalidTokenMint
    );

    // Move token a from maker's ATA to the vault
    transfer_tokens(
        &context.accounts.maker_token_account_a,
        &context.accounts.vault,
        &token_a_offered_amount,
        &context.accounts.token_mint_a,
        &context.accounts.maker.to_account_info(),
        &context.accounts.token_program,
        None,
    )
    .map_err(|_| ErrorCode::InsufficientMakerBalance)?;

    // store offer details in the offer account
    context.accounts.offer.set_inner(Offer {
        id,
        maker: context.accounts.maker.key(),
        token_mint_a: context.accounts.token_mint_a.key(),
        token_mint_b: context.accounts.token_mint_b.key(),
        token_b_wanted_amount,
        bump: context.bumps.offer,
    });
    Ok(())
}
