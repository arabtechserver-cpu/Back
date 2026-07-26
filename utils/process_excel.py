import sys
import os
import json
import pandas as pd

def clean_price(price_val):
    if pd.isna(price_val):
        return 0.0
    val_str = str(price_val).strip()
    # Remove $, commas, or other currency signs
    val_str = val_str.replace('$', '').replace(',', '').strip()
    try:
        return float(val_str)
    except ValueError:
        return 0.0

def process_excel(file_path):
    if not os.path.exists(file_path):
        print(json.dumps({"error": f"File not found: {file_path}"}))
        sys.exit(1)

    try:
        # Read the excel sheet
        df = pd.read_excel(file_path)
        
        # Verify required columns exist
        required_cols = ['Category/Group', 'Service Name', 'Price']
        missing_cols = [col for col in required_cols if col not in df.columns]
        if missing_cols:
            print(json.dumps({"error": f"Missing required columns: {missing_cols}"}))
            sys.exit(1)
            
        # Group by 'Category/Group'
        grouped = df.groupby('Category/Group')
        services = []
        
        for name, group in grouped:
            packages = []
            min_price_usd = float('inf')
            
            for idx, row in group.iterrows():
                service_name = str(row['Service Name']).strip()
                raw_price = row['Price']
                usd_price = clean_price(raw_price)
                
                # Check status if column exists
                status = "Available"
                if 'Status' in row and not pd.isna(row['Status']):
                    status = str(row['Status']).strip()
                
                delivery_time = ""
                if 'Delivery Time' in row and not pd.isna(row['Delivery Time']):
                    delivery_time = str(row['Delivery Time']).strip()
                
                # We'll put delivery time in package name if applicable, or keep it as is
                pkg_name = service_name
                if delivery_time:
                    pkg_name += f" ({delivery_time})"
                    
                packages.append({
                    "id": len(packages) + 1,
                    "name": pkg_name,
                    "usd_price": usd_price,
                    "price": usd_price, # Temporary EGP price, will be recalculated in Node.js
                    "status": status
                })
                
                if usd_price < min_price_usd:
                    min_price_usd = usd_price
            
            if min_price_usd == float('inf'):
                min_price_usd = 0.0
                
            services.append({
                "name": str(name).strip(),
                "description": f"تفعيل واشتراك خدمات {name}",
                "price": min_price_usd, # Temporary min EGP price, will be recalculated in Node.js
                "packages": packages
            })
            
        print(json.dumps(services, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    process_excel(sys.argv[1])
