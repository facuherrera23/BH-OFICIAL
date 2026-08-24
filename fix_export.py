with open('assets/js/admin-app.js', 'rb') as f:
    content = f.read()

# Find the marker
marker = b'}\r\n\r\n\r\n// ===== VISTA ML DASHBOARD ==='
idx = content.find(marker)
if idx == -1:
    marker = b'}\n\n\n// ===== VISTA ML DASHBOARD ==='
    idx = content.find(marker)
    if idx == -1:
        print('Marker not found')
        exit(1)

print('Found at index', idx)

# Read the export function
with open('export_supervision.js', 'rb') as f:
    export_code = f.read()

# Insert after the first } (end of loadSupvRules)
insert_pos = idx + len(b'}')
new_content = content[:insert_pos] + b'\r\n\r\n' + export_code + content[insert_pos:]

with open('assets/js/admin-app.js', 'wb') as f:
    f.write(new_content)

print('Successfully inserted exportSupervision function')