// Load environment variables
require('dotenv').config();
const fs = require('fs');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const JUPITER_STAKING_PROGRAM = 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj';
const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const DATA_FILE = 'jupiter_daily_staking.json';

class DailyStakingUpdater {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.helius.xyz';
        this.yesterdayData = {
            staked: 0,
            withdrawn: 0,
            netChange: 0,
            transactionCount: 0
        };
    }

    getYesterdayDate() {
        const yesterday = new Date();
        yesterday.setUTCDate(yesterday.getUTCDate() - 1);
        return yesterday.toISOString().split('T')[0];
    }

    getTodayDate() {
        return new Date().toISOString().split('T')[0];
    }

    async fetchTransactionsByAddress(address, beforeSignature = null, limit = 100) {
        const url = `${this.baseUrl}/v0/addresses/${address}/transactions`;
        const params = new URLSearchParams({
            'api-key': this.apiKey,
            limit: limit.toString(),
            commitment: 'finalized'
        });

        if (beforeSignature) {
            params.append('before', beforeSignature);
        }

        const response = await fetch(`${url}?${params}`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    }

    parseInstructionData(instruction) {
        if (instruction.programId !== JUPITER_STAKING_PROGRAM) {
            return null;
        }

        const data = instruction.data;
        const INSTRUCTION_PATTERNS = {
            "akdNKvmXxTg": "withdrawPartialUnstaking",
            "Xd2GMpFXgQ1": "withdraw", 
            "hXMy9aWmoGcFwgKCTXYVV": "increaseLockedAmount",
            "35nv67PJjDCyd": "toggleMaxLock",
            "akdNKv": "withdrawPartialUnstaking",
            "Xd2GMp": "withdraw",
            "hXMy9a": "increaseLockedAmount",
            "35nv67": "toggleMaxLock"
        };

        let instructionType = INSTRUCTION_PATTERNS[data];
        if (!instructionType) {
            const dataPrefix = data.substring(0, 6);
            instructionType = INSTRUCTION_PATTERNS[dataPrefix];
        }

        return { type: instructionType || 'unknown' };
    }

    extractAmountFromTokenTransfers(tokenTransfers) {
        if (!tokenTransfers || tokenTransfers.length === 0) {
            return 0;
        }

        const jupTransfers = tokenTransfers.filter(transfer => 
            transfer.mint === JUP_MINT
        );

        if (jupTransfers.length === 0) {
            return 0;
        }

        return jupTransfers[0].tokenAmount || 0;
    }

    processTransaction(transaction, targetDate) {
        const txDate = new Date(transaction.timestamp * 1000).toISOString().split('T')[0];
        
        // Only process transactions from the target date
        if (txDate !== targetDate) {
            return false;
        }

        let hasStakingActivity = false;

        if (transaction.instructions) {
            for (const instruction of transaction.instructions) {
                // Check direct Jupiter staking instructions
                if (instruction.programId === JUPITER_STAKING_PROGRAM) {
                    const parsedInstruction = this.parseInstructionData(instruction);
                    
                    if (parsedInstruction && parsedInstruction.type !== 'unknown' && parsedInstruction.type !== 'toggleMaxLock') {
                        const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                        
                        if (amount > 0) {
                            if (parsedInstruction.type === 'increaseLockedAmount') {
                                this.yesterdayData.staked += amount;
                            } else if (parsedInstruction.type === 'withdraw' || parsedInstruction.type === 'withdrawPartialUnstaking') {
                                this.yesterdayData.withdrawn += amount;
                            }
                            hasStakingActivity = true;
                        }
                    }
                }

                // Check inner instructions for claim-and-stake
                if (instruction.innerInstructions) {
                    for (const innerInstruction of instruction.innerInstructions) {
                        if (innerInstruction.programId === JUPITER_STAKING_PROGRAM) {
                            const parsedInner = this.parseInstructionData(innerInstruction);
                            
                            if (parsedInner && parsedInner.type !== 'unknown' && parsedInner.type !== 'toggleMaxLock') {
                                const amount = this.extractAmountFromTokenTransfers(transaction.tokenTransfers);
                                
                                if (amount > 0) {
                                    if (parsedInner.type === 'increaseLockedAmount') {
                                        this.yesterdayData.staked += amount;
                                    } else if (parsedInner.type === 'withdraw' || parsedInner.type === 'withdrawPartialUnstaking') {
                                        this.yesterdayData.withdrawn += amount;
                                    }
                                    hasStakingActivity = true;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (hasStakingActivity) {
            this.yesterdayData.transactionCount++;
        }

        return hasStakingActivity;
    }

    async fetchYesterdayTransactions(targetDate) {
        console.log(`🔍 Fetching transactions for ${targetDate}...`);
        
        let beforeSignature = null;
        let hasMore = true;
        let batchCount = 0;
        let processedTransactions = 0;

        // Set up date boundaries
        const targetTimestamp = new Date(targetDate).getTime() / 1000;
        const nextDayTimestamp = new Date(targetDate + 'T23:59:59.999Z').getTime() / 1000;

        while (hasMore) {
            console.log(`  Fetching batch ${++batchCount}...`);
            
            const transactions = await this.fetchTransactionsByAddress(
                JUPITER_STAKING_PROGRAM, 
                beforeSignature, 
                100
            );

            if (!transactions || transactions.length === 0) {
                console.log('  No more transactions found');
                hasMore = false;
                break;
            }

            // Process transactions for target date only
            for (const transaction of transactions) {
                if (this.processTransaction(transaction, targetDate)) {
                    processedTransactions++;
                }
            }

            const oldestTx = transactions[transactions.length - 1];
            
            // Stop if we've gone past our target date
            if (oldestTx.timestamp < targetTimestamp) {
                console.log(`  Reached before target date ${targetDate}`);
                hasMore = false;
                break;
            }

            beforeSignature = oldestTx.signature;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Calculate net change
        this.yesterdayData.netChange = this.yesterdayData.staked - this.yesterdayData.withdrawn;

        console.log(`✅ Processed ${processedTransactions} staking transactions for ${targetDate}`);
        console.log(`   Staked: ${this.yesterdayData.staked.toLocaleString()} JUP`);
        console.log(`   Withdrawn: ${this.yesterdayData.withdrawn.toLocaleString()} JUP`);
        console.log(`   Net Change: ${this.yesterdayData.netChange > 0 ? '+' : ''}${this.yesterdayData.netChange.toLocaleString()} JUP`);
        console.log(`   Transactions: ${this.yesterdayData.transactionCount}`);

        return this.yesterdayData;
    }

    loadExistingData() {
        try {
            if (!fs.existsSync(DATA_FILE)) {
                console.log(`❌ Data file not found: ${DATA_FILE}`);
                return null;
            }

            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            console.log(`📊 Loaded existing data: ${data.summary.totalRecords} records`);
            console.log(`📅 Latest date: ${data.summary.latestDate}`);
            console.log(`💰 Latest total: ${data.summary.latestTotal.toLocaleString()} JUP`);
            
            return data;
        } catch (error) {
            console.error(`❌ Error loading data: ${error.message}`);
            return null;
        }
    }

    updateDataWithYesterday(existingData, yesterdayData, targetDate) {
        // Check if target date already exists
        const existingEntry = existingData.dailyData.find(entry => entry.date === targetDate);
        if (existingEntry) {
            console.log(`⚠️  Date ${targetDate} already exists in data - skipping update`);
            return existingData;
        }

        // Calculate new total
        const previousTotal = existingData.summary.latestTotal;
        const newTotal = previousTotal + yesterdayData.netChange;

        // Add new entry at the beginning (newest first)
        const newEntry = {
            date: targetDate,
            totalStaked: newTotal
        };

        existingData.dailyData.unshift(newEntry);

        // Update summary
        existingData.summary.totalRecords = existingData.dailyData.length;
        existingData.summary.latestDate = targetDate;
        existingData.summary.latestTotal = newTotal;

        console.log(`📈 Updated total: ${previousTotal.toLocaleString()} → ${newTotal.toLocaleString()} JUP`);
        console.log(`📊 Total records: ${existingData.summary.totalRecords}`);

        return existingData;
    }

    saveData(data) {
        try {
            // Save JSON only
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
            console.log(`💾 Data saved to: ${DATA_FILE}`);
            return true;
        } catch (error) {
            console.error(`❌ Error saving data: ${error.message}`);
            return false;
        }
    }

    async runDailyUpdate() {
        const today = this.getTodayDate();
        const yesterday = this.getYesterdayDate();
        
        console.log(`🚀 Starting daily update for ${yesterday}`);
        console.log(`📅 Today: ${today}, Processing: ${yesterday}`);

        try {
            // Load existing data
            const existingData = this.loadExistingData();
            if (!existingData) {
                console.log('❌ Cannot proceed without existing data');
                return false;
            }

            // Check if yesterday is already processed
            if (existingData.summary.latestDate === yesterday) {
                console.log(`✅ Data for ${yesterday} already exists - no update needed`);
                return true;
            }

            if (existingData.summary.latestDate > yesterday) {
                console.log(`⚠️  Latest date (${existingData.summary.latestDate}) is newer than target (${yesterday})`);
                return false;
            }

            // Fetch yesterday's transactions
            const yesterdayData = await this.fetchYesterdayTransactions(yesterday);

            // Update data
            const updatedData = this.updateDataWithYesterday(existingData, yesterdayData, yesterday);

            // Save updated data
            const saved = this.saveData(updatedData);

            if (saved) {
                console.log('\n🎉 === DAILY UPDATE COMPLETE ===');
                console.log(`📅 Updated date: ${yesterday}`);
                console.log(`💰 Current total: ${updatedData.summary.latestTotal.toLocaleString()} JUP`);
                console.log(`📊 Total records: ${updatedData.summary.totalRecords}`);
                return true;
            } else {
                console.log('❌ Failed to save data');
                return false;
            }

        } catch (error) {
            console.error(`❌ Daily update failed: ${error.message}`);
            return false;
        }
    }
}

// Main execution
async function runDailyWorkflow() {
    console.log('📋 === JUPITER STAKING DAILY WORKFLOW ===\n');
    
    const updater = new DailyStakingUpdater(HELIUS_API_KEY);
    const success = await updater.runDailyUpdate();
    
    process.exit(success ? 0 : 1);
}

runDailyWorkflow();