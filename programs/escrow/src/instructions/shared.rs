use anchor_lang::prelude::*;

use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};

// Transfer tokens from one account to another
pub fn transfer_tokens<'info>(
    from: &InterfaceAccount<'info, TokenAccount>, // token account to transfer from
    to: &InterfaceAccount<'info, TokenAccount>, // token account to transfer to
    amount: &u64, // amount of tokens to transfer
    mint: &InterfaceAccount<'info, Mint>, // mint of the tokens to transfer
    authority: &AccountInfo<'info>, // authority of the tokens to transfer
    token_program: &Interface<'info, TokenInterface>, // token program to use for the transfer.
    owning_pda_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let transfer_accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: authority.to_account_info(),
    };

    let signers_seeds = owning_pda_seeds.map(|seeds| [seeds]);

    // Do the transfer, by calling transfer_checked - providing a different CPI context
    // depending on whether we're sending tokens from a PDA or not
    transfer_checked(
        if let Some(seeds_arr) = signers_seeds.as_ref() {
            // used when the PDA is the authority doing the transfer
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                transfer_accounts,
                seeds_arr,
            )
        } else {
            // used when user's keypair is already a signer of the transaction
            CpiContext::new(token_program.to_account_info(), transfer_accounts)
        },
        *amount,
        mint.decimals,
    )
}

// close the token account and refund rent to the destination account
// If the token account is owned by a PDA, owning_pda_seeds must be provided.
pub fn close_token_account<'info>(
    token_account: &InterfaceAccount<'info, TokenAccount>, // account to close
    destination: &AccountInfo<'info>, // account to refund rent to
    authority: &AccountInfo<'info>, // authority of the account to close
    token_program: &Interface<'info, TokenInterface>, // 
    owning_pda_seeds: Option<&[&[u8]]>,
) -> Result<()> {
    let close_accounts = CloseAccount {
        account: token_account.to_account_info(),
        destination: destination.to_account_info(),
        authority: authority.to_account_info(),
    };


    let signers_seeds = owning_pda_seeds.map(|seeds| [seeds]);

    // close account
    close_account(if let Some(seeds_arr) = signers_seeds.as_ref() {
        CpiContext::new_with_signer(token_program.to_account_info(), close_accounts, seeds_arr)
    } else {
        CpiContext::new(token_program.to_account_info(), close_accounts)
    })
}
