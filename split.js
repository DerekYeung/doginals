#!/usr/bin/env node

const dogecore = require('bitcore-lib-doge')
const axios = require('axios')
const fs = require('fs')
const dotenv = require('dotenv')
const mime = require('mime-types')
const express = require('express')
const {
    PrivateKey,
    Address,
    Transaction,
    Script,
    Opcode,
    HDPrivateKey
} = dogecore
const {
    Hash,
    Signature
} = dogecore.crypto
const {
    generateMnemonic: _generateMnemonic,
    mnemonicToSeed,
} = require('@scure/bip39');
const {
    wordlist,
} = require('@scure/bip39/wordlists/english');

function generateMnemonic(entropy = 256) {
    if (entropy !== 256 && entropy !== 128) {
        throw TypeError(
            `Incorrect entropy bits provided, expected 256 or 128 (24 or 12 word results), got: "${String(
        entropy
      )}".`
        );
    }
    return _generateMnemonic(wordlist, entropy);
}


if (fs.existsSync('.lock')) {
    throw new Error('lock!');
}
fs.writeFileSync('.lock', 'locking');
const shutdown = () => {
    try {
        fs.unlinkSync('.lock');
    } catch (e) {

    }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

dotenv.config()

if (process.env.TESTNET == 'true') {
    dogecore.Networks.defaultNetwork = dogecore.Networks.testnet
}

if (process.env.FEE_PER_KB) {
    Transaction.FEE_PER_KB = parseInt(process.env.FEE_PER_KB)
} else {
    Transaction.FEE_PER_KB = 100000000
}

const WALLET_PATH = process.env.WALLET || '.wallet.json'


async function main() {
    let cmd = process.argv[2]

    if (cmd == 'mint') {
        await mint()
    } else if (cmd == 'wallet') {
        await wallet()
    } else if (cmd == 'server') {
        await server()
    } else {
        throw new Error(`unknown command: ${cmd}`)
    }
}


async function wallet() {
    let subcmd = process.argv[3]

    if (subcmd == 'new') {
        walletNew()
    } else if (subcmd == 'sync') {
        await walletSync()
    } else if (subcmd == 'balance') {
        walletBalance()
    } else if (subcmd == 'send') {
        await walletSend()
    } else if (subcmd == 'split') {
        await walletSplit()
    } else {
        throw new Error(`unknown subcommand: ${subcmd}`)
    }
}


async function walletNew() {

    if (!fs.existsSync(WALLET_PATH)) {
        const hdPrivKey = new HDPrivateKey();
        const hotWallet = hdPrivKey.deriveChild("m/44'/236'/0'/0/0");
        const sendWallet = hdPrivKey.deriveChild("m/44'/236'/0'/1/0");
        const xprivkey = hdPrivKey.xprivkey;

        const privkey = hotWallet.privateKey.toWIF();
        const address = hotWallet.privateKey.toAddress().toString();
        const sendKey = sendWallet.privateKey.toWIF();
        const sendAddress = sendWallet.privateKey.toAddress().toString();

        const json = {
            xprivkey,
            privkey,
            address,
            sendKey,
            sendAddress,
            utxos: []
        }
        fs.writeFileSync(WALLET_PATH, JSON.stringify(json, 0, 2))
        console.log('address', address)
    } else {
        throw new Error('wallet already exists')
    }
}


async function walletSync() {
    if (process.env.TESTNET == 'true') throw new Error('no testnet api')

    let wallet = JSON.parse(fs.readFileSync('.wallet.json'))

    let response = await axios.get(`${process.env.NODE_API_URL}/address/${wallet.address}/unspent`)
    const script = dogecore.Script.fromAddress(wallet.address).toHex();
    utxos = response.data.data.map(output => {
        return {
            txid: output.tx_hash,
            vout: output.tx_pos,
            script,
            satoshis: output.value
        }
    })
    utxos.sort((a, b) => {
        return b.satoshis - a.satoshis;
    })
    wallet.utxos = utxos || [];

    fs.writeFileSync('.wallet.json', JSON.stringify(wallet, 0, 2))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log('balance', balance)
}


function walletBalance() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)

    console.log(wallet.address, balance)
}


async function walletSend() {
    const argAddress = process.argv[4]
    const argAmount = process.argv[5]

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    let balance = wallet.utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to send')

    let receiver = new Address(argAddress)
    let amount = parseInt(argAmount)

    let tx = new Transaction()
    if (amount) {
        tx.to(receiver, amount)
        fund(wallet, tx)
    } else {
        tx.from(wallet.utxos)
        tx.change(receiver)
        tx.sign(wallet.privkey)
    }

    await broadcast(tx)

    console.log(tx.hash)
}


async function walletSplit() {
    const pk = PrivateKey.fromWIF(process.env.SPLIT_KEY);
    const address = pk.toAddress().toString();

    const response = await axios.get(`${process.env.NODE_API_URL}/address/${address}/unspent`)
    const script = dogecore.Script.fromAddress(address).toHex();
    const unspent = response.data.data.map(output => {
        return {
            txid: output.tx_hash,
            vout: output.tx_pos,
            script,
            satoshis: output.value
        }
    })
    let splits = parseInt(process.argv[2] || 100);

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH));
    const unit = parseInt(process.argv[5] || 100000000);
    const utxos = (unspent || []).filter(node => {
        return node.satoshis >= (unit * 2);
    });

    let balance = utxos.reduce((acc, curr) => acc + curr.satoshis, 0)
    if (balance == 0) throw new Error('no funds to split')

    let tx = new Transaction()
    tx.from(utxos)
    for (let i = 0; i < splits - 1; i++) {
        tx.to(wallet.address, unit);
    }
    tx.change(address)
    tx.sign(pk)

    await broadcast(tx)
    console.log(tx.hash)

    // await new Promise(resolve => {
    //     setTimeout(() => {
    //         resolve(true);
    //     }, 3000);
    // })
    // await walletSync();
}


const MAX_SCRIPT_ELEMENT_SIZE = 520

async function mint() {
    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))
    if (!wallet.sendAddress) {
        throw new Error('Missing send address');
    }
    const filepath = process.argv[3]
    const customAddress = process.argv[4]
    const sendAddress = customAddress || wallet.sendAddress;

    let address = new Address(sendAddress)
    let contentType
    let data

    if (fs.existsSync(filepath)) {
        contentType = mime.contentType(mime.lookup(argContentTypeOrFilename))
        data = fs.readFileSync(argContentTypeOrFilename)
    }

    if (data.length == 0) {
        throw new Error('no data to mint')
    }

    if (contentType.length > MAX_SCRIPT_ELEMENT_SIZE) {
        throw new Error('content type too long')
    }

    let txs = inscribe(wallet, address, contentType, data)

    for (let i = 0; i < txs.length; i++) {
        await broadcast(txs[i])
    }
    const result = {
        inscription: txs[1].hash,
        sendAddress
    }
    console.log(result);
}

function updateWallet(wallet, tx) {
    wallet.utxos = wallet.utxos.filter(utxo => {
        for (const input of tx.inputs) {
            if (input.prevTxId.toString('hex') == utxo.txid && input.outputIndex == utxo.vout) {
                return false
            }
        }
        return true
    })

    tx.outputs
        .forEach((output, vout) => {
            if (output.script.toAddress().toString() == wallet.address) {
                wallet.utxos.push({
                    txid: tx.hash,
                    vout,
                    script: output.script.toHex(),
                    satoshis: output.satoshis
                })
            }
        })
}


async function broadcast(tx) {
    const body = {
        jsonrpc: "1.0",
        id: 0,
        method: "sendrawtransaction",
        params: [tx.toString()]
    }

    const options = {
        auth: {
            username: process.env.NODE_RPC_USER,
            password: process.env.NODE_RPC_PASS
        }
    }

    while (true) {
        try {
            await axios.post(process.env.NODE_RPC_URL, body, options)
            break
        } catch (e) {
            let msg = e.response && e.response.data && e.response.data.error && e.response.data.error.message
            if (msg && msg.includes('too-long-mempool-chain')) {
                console.warn('retrying, too-long-mempool-chain')
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw e
            }
        }
    }

    let wallet = JSON.parse(fs.readFileSync(WALLET_PATH))

    updateWallet(wallet, tx)

    fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, 0, 2))
}



walletSplit().catch(e => {
    shutdown();
    throw e;
}).finally(() => {
    shutdown();
})
