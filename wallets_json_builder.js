const fs = require('fs');

function generateWalletStatesJSON() {
    try {
        // Read the CSV file
        const csvContent = fs.readFileSync('staking_wallets.csv', 'utf8');
        const lines = csvContent.trim().split('\n');
        
        // Skip header line and process data
        const wallets = {};
        let totalWallets = 0;
        let totalStakedAmount = 0;
        
        for (let i = 1; i < lines.length; i++) { // Skip header row
            const line = lines[i].trim();
            if (!line) continue; // Skip empty lines
            
            const [walletAddress, stakedBalance] = line.split(',');
            
            if (walletAddress && stakedBalance) {
                const balance = parseFloat(stakedBalance);
                
                // Only include wallets with positive balance
                if (balance > 0.0000009999) {
                    wallets[walletAddress.trim()] = balance;
                    totalWallets++;
                    totalStakedAmount += balance;
                }
            }
        }
        
        // Create the JSON structure
        const walletStatesData = {
            asOfDate: "2025-07-29",
            wallets: wallets
        };
        
        // Write to file
        const outputPath = 'wallet_states.json';
        fs.writeFileSync(outputPath, JSON.stringify(walletStatesData, null, 2));
        
        console.log(`✅ Generated ${outputPath}`);
        console.log(`📊 Summary:`);
        console.log(`   As of Date: 2025-07-29`);
        console.log(`   Total Active Wallets: ${totalWallets.toLocaleString()}`);
        console.log(`   Total Staked Amount: ${totalStakedAmount.toLocaleString()} JUP`);
        console.log(`   Average Balance: ${(totalStakedAmount / totalWallets).toFixed(2)} JUP`);
        
        // Validation check
        console.log(`\n🔍 Validation:`);
        console.log(`   Wallets in file: ${Object.keys(wallets).length}`);
        console.log(`   Sample wallet: ${Object.keys(wallets)[0]} = ${Object.values(wallets)[0]}`);
        
        return walletStatesData;
        
    } catch (error) {
        console.error('❌ Error processing CSV:', error.message);
        console.error('Make sure staking_wallets.csv exists in the current directory');
        throw error;
    }
}

// Run the script
if (require.main === module) {
    generateWalletStatesJSON();
}

module.exports = { generateWalletStatesJSON };