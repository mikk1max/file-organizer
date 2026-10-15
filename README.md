# file-organizer

CLI-застосунок на Node.js для наведення порядку в директоріях (наприклад, `Downloads`): аналіз вмісту, пошук дублікатів, сортування файлів по категоріях та видалення застарілих файлів.

Застосунок не має зовнішніх залежностей — використовуються лише вбудовані модулі Node.js (`fs`, `path`, `crypto`, `events`, `stream`).

## Встановлення

Потрібен **Node.js 18** або новіший.

```bash
git clone <посилання-на-репозиторій>
cd file-organizer
npm install
```

`npm install` не обов'язковий (залежностей немає), але не зашкодить.

## Швидкий старт

```bash
node file-organizer.js scan ~/Downloads
node file-organizer.js duplicates ~/Downloads
node file-organizer.js organize ~/Downloads --output ~/Organized
node file-organizer.js cleanup ~/Downloads --older-than 90
node file-organizer.js cleanup ~/Downloads --older-than 90 --confirm
```

Те саме через npm scripts (аргументи передаються після `--`):

```bash
npm run scan -- ~/Downloads
npm run duplicates -- ~/Downloads
npm run organize -- ~/Downloads --output ~/Organized
npm run cleanup -- ~/Downloads --older-than 90 --confirm
```

Довідка: `node file-organizer.js --help`

## Команди

### `scan <directory>`

Рекурсивно обходить директорію та всі піддиректорії і виводить статистику.

| Аргумент | Опис |
| --- | --- |
| `<directory>` | Директорія для аналізу (обов'язковий) |

Звіт містить:

- загальну кількість файлів та їх сумарний розмір;
- розподіл за типом (розширенням): кількість і розмір для кожного типу. Показується 10 найбільших типів, решта об'єднується в `(other)`;
- вік файлів: змінені за останні 7 днів, за останні 30 днів, старіші за 90 днів;
- топ-3 найбільших файли;
- найстаріший файл.

```bash
node file-organizer.js scan ~/Downloads
```

```
📂 Scanning: /Users/student/Downloads
Processing... ████████████████████ 247/247 files

📊 Scan Results:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total files: 247
Total size: 1.20 GB

By File Type:
  .pdf    89 files  456.0 MB
  .zip    23 files  234.0 MB
  ...

File Age:
  Last 7 days:    45 files
  Last 30 days:   89 files
  Older than 90:  56 files

Largest files:
  1. video_lecture.mp4     450.0 MB
  2. archive_backup.zip    156.0 MB
  3. presentation.pptx      89.0 MB

Oldest file: old_report.pdf (modified 365 days ago)
```

### `duplicates <directory>`

Шукає файли з однаковим вмістом (незалежно від назви) за допомогою SHA-256.

| Аргумент | Опис |
| --- | --- |
| `<directory>` | Директорія для пошуку дублікатів (обов'язковий) |

Як це працює:

1. Файли спочатку групуються за розміром — файли різного розміру не можуть бути однаковими, тому їх хеш не рахується. Порожні файли пропускаються.
2. Для решти обчислюється SHA-256 через `fs.createReadStream()` — файл читається частинами (chunks), тому навіть дуже великі файли не завантажуються в пам'ять повністю.
3. Файли групуються в `Map<hash, Array<filePath>>`; дублікатами вважаються групи, де більше одного файлу.
4. Витрачене місце = розмір файлу × (кількість копій − 1).

```bash
node file-organizer.js duplicates ~/Downloads
```

```
🔍 Searching for duplicates in: /Users/student/Downloads
Scanned 247 files, 31 with matching sizes need hashing
Calculating hashes... ████████████████████ 31/31 files

Found 3 duplicate groups (8.7 MB wasted):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Group 1 (3 copies, 3.2 MB each):
  SHA-256: a3f2e1b8c4d5...

  📄 Downloads/lecture.pdf
  📄 Downloads/lecture(1).pdf
  📄 Downloads/backup/lecture_copy.pdf

  Wasted space: 6.4 MB
...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💾 Total wasted space: 8.7 MB
```

### `organize <source> --output <target>`

Копіює файли з `<source>` у `<target>`, розкладаючи їх по директоріях категорій. **Оригінали залишаються на місці.**

| Аргумент | Опис |
| --- | --- |
| `<source>` | Директорія з файлами (обов'язковий) |
| `--output <target>` | Куди копіювати (обов'язковий). Створюється автоматично, якщо не існує |

Категорії:

| Категорія | Розширення |
| --- | --- |
| Documents | `.pdf .docx .doc .txt .md .xlsx .pptx` |
| Images | `.png .jpg .jpeg .gif .svg .webp .bmp` |
| Archives | `.zip .rar .tar .gz .7z` |
| Code | `.js .py .java .cpp .html .css .json` |
| Videos | `.mp4 .avi .mkv .mov .webm` |
| Other | усе інше |

Особливості:

- Файли **менші за 10 MB** копіюються через `fs.copyFile()`, файли **від 10 MB** — через streams (`pipeline()` з `stream/promises`), щоб не тримати весь файл у пам'яті.
- Існуючі файли не перезаписуються: якщо `file.pdf` вже є, файл буде збережено як `file(1).pdf`, потім `file(2).pdf` і т.д.
- Якщо `<target>` знаходиться всередині `<source>`, ця директорія пропускається при скануванні, щоб не копіювати вже відсортовані файли повторно.
- `<source>` і `<target>` не можуть бути однією директорією.

```bash
node file-organizer.js organize ~/Downloads --output ~/Organized
```

```
📦 Organizing: /Users/student/Downloads
Target: /Users/student/Organized

Creating folders...
  ✓ Documents/
  ✓ Images/
  ✓ Archives/
  ✓ Code/
  ✓ Videos/
  ✓ Other/

Copying files... ████████████████████ 247/247

✅ Organization complete!

Summary:
  Documents: 134 files → Organized/Documents/
  Images:     67 files → Organized/Images/
  Archives:   23 files → Organized/Archives/
  Code:       12 files → Organized/Code/
  Videos:      8 files → Organized/Videos/
  Other:       3 files → Organized/Other/

Total copied: 247 files (1.20 GB)
```

### `cleanup <directory> --older-than <days> [--confirm]`

Знаходить файли, які не змінювалися довше за вказану кількість днів (за `mtime`), і за потреби видаляє їх.

| Аргумент | Опис |
| --- | --- |
| `<directory>` | Директорія для пошуку (обов'язковий) |
| `--older-than <days>` | Поріг віку в днях (обов'язковий, невід'ємне число) |
| `--confirm` | Фактично видалити знайдені файли. Без цього прапорця працює режим **dry run** |

**Dry run** (за замовчуванням) — лише показує список файлів, нічого не видаляючи:

```bash
node file-organizer.js cleanup ~/Downloads --older-than 90
```

```
🧹 Cleanup: /Users/student/Downloads
Looking for files older than 90 days...

Found 45 files to delete:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Downloads/old_report.pdf
  Size: 2.3 MB
  Modified: 120 days ago (2024-09-05)
...
... (35 more files)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Total: 45 files (156.0 MB)

⚠️  DRY RUN MODE: No files were deleted.
To actually delete these files, run with --confirm flag.
```

**Видалення** — показує той самий список, після чого видаляє файли через `fs.unlink()`:

```bash
node file-organizer.js cleanup ~/Downloads --older-than 90 --confirm
```

```
...
⚠️  DELETING 45 files (156.0 MB). This action cannot be undone!

Deleting... ████████████████████ 45/45

✅ Cleanup complete!
Deleted: 45 files (156.0 MB freed)
```

У списку показуються 10 найстаріших файлів, решта — підсумковим рядком.

## Обробка помилок

- Усі файлові операції обгорнуті в `try...catch`.
- Критичні помилки (директорію не знайдено, немає доступу, шлях не є директорією, невірні аргументи) виводять зрозуміле повідомлення і завершують програму з кодом `1`:

  ```
  ❌ Error: Directory not found: /path/to/dir
  ❌ Error: Permission denied: /path/to/dir
  ❌ Error: Not a directory: /path/to/file.txt
  ```

- Помилки окремих файлів (наприклад, немає доступу до піддиректорії або файл видалено під час роботи) не зупиняють команду — такі файли пропускаються, а в кінці виводиться їх список з причиною (`ENOENT`, `EACCES`, `EPERM`, `ENOSPC`, `EBUSY` та ін.).

## Архітектура

Кожна команда — окремий клас, що наслідується від `EventEmitter`. Класи містять тільки логіку і нічого не виводять у консоль; `file-organizer.js` підписується на їх події, малює прогрес-бар і форматує звіти.

| Клас | Файл | Події |
| --- | --- | --- |
| `Scanner` | `lib/scanner.js` | `scan-start`, `files-listed`, `file-found`, `file-error`, `scan-complete` |
| `DuplicateFinder` | `lib/duplicates.js` | `search-start`, `hashing-start`, `file-processed`, `file-error`, `duplicates-found` |
| `Organizer` | `lib/organizer.js` | `organize-start`, `folder-created`, `copy-begin`, `copy-start`, `copy-complete`, `copy-error`, `organize-complete` |
| `Cleanup` | `lib/cleanup.js` | `search-start`, `file-found`, `search-complete`, `delete-start`, `file-deleted`, `file-error`, `cleanup-complete` |

Приклад використання класу окремо від CLI:

```js
import { Scanner } from './lib/scanner.js';

const scanner = new Scanner();
scanner.on('file-found', ({ current, total }) => console.log(`${current}/${total}`));
scanner.on('scan-complete', (stats) => console.log(stats.totalFiles));

await scanner.scan('/path/to/directory');
```

## Структура проєкту

```
file-organizer/
├── package.json        # конфігурація, "type": "module", npm scripts
├── .gitignore
├── README.md
├── file-organizer.js   # точка входу: парсинг аргументів, вивід, прогрес-бар, обробка помилок
└── lib/
    ├── scanner.js      # Scanner + рекурсивний обхід директорій (listFiles)
    ├── duplicates.js   # DuplicateFinder + calculateHash (SHA-256 через stream)
    ├── organizer.js    # Organizer, категорії, копіювання, вирішення конфліктів назв
    └── cleanup.js      # Cleanup: пошук старих файлів і видалення
```
