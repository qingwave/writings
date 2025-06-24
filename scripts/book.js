const axios = require('axios');
const fs = require('fs');
const yaml = require('js-yaml');

const INPUT_FILE = 'src/reading.yaml';
const OUTPUT_FILE = 'src/books.js';
const DOUBAN_SEARCH_URL = 'https://search.douban.com/book/subject_search?search_text=';

/**
 * Fetch book information from Douban.
 * @param {string} bookTitle - The title of the book to search for.
 * @returns {object|null} - The best matching book information or null if not found.
 */
async function fetchDoubanBook(bookTitle) {
    try {
        const searchUrl = `${DOUBAN_SEARCH_URL}${encodeURIComponent(bookTitle)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const html = response.data;

        const match = html.match(/window\.__DATA__\s*=\s*({.+?});/s);
        if (!match) return null;

        const items = JSON.parse(match[1]).items || [];
        if (items.length === 0) return null;

        const scoredItems = items.map(item => ({
            ...item,
            titleMatchScore: calculateTitleMatchScore(bookTitle, item.title || ""),
            itemRating: item.rating?.count || 0
        }));

        scoredItems.sort((a, b) => {
            if (b.titleMatchScore !== a.titleMatchScore) {
                return b.titleMatchScore - a.titleMatchScore;
            }
            return b.itemRating - a.itemRating;
        });

        return scoredItems[0];
    } catch (error) {
        console.error(`Error fetching book data for "${bookTitle}":`, error);
        return null;
    }
}

/**
 * Calculate title match score based on character overlap.
 * @param {string} searchTitle - The search title.
 * @param {string} itemTitle - The title to compare against.
 * @returns {number} - The match score.
 */
function calculateTitleMatchScore(searchTitle, itemTitle) {
    if (searchTitle === itemTitle) return 1.0;
    if (itemTitle.includes(searchTitle)) return 0.95;
    if (searchTitle.includes(itemTitle)) return 0.90;

    const sSet = new Set(searchTitle.split(''));
    const tSet = new Set(itemTitle.split(''));
    const intersection = [...sSet].filter(c => tSet.has(c)).length;
    const union = new Set([...sSet, ...tSet]).size;

    return intersection / union;
}

/**
 * Fetch and process book information from the input YAML file.
 */
async function fetchBooksInfo() {
    try {
        const fileContents = fs.readFileSync(INPUT_FILE, 'utf8');
        const data = yaml.load(fileContents);
        const existingBooks = fs.existsSync(OUTPUT_FILE)
            ? JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8').replace('export const books = ', '').replace(';', ''))
            : [];

        const books = await Promise.all(data.books.map(async book => {
            if (!book.name) {
                console.error('Book information missing title:', book);
                return null;
            }

            const existingBook = existingBooks.find(b => b.name === book.name);
            if (existingBook && existingBook.data) {
                console.log(`Skipping fetch data "${book.name}" as it already has data.`);
                return { ...book, data: existingBook.data };
            }

            const bookInfo = await fetchDoubanBook(book.name);
            if (bookInfo) {
                console.log(`Fetched information for "${book.name}".`);
                return { ...book, data: bookInfo };
            }

            return null;
        }));

        const filteredBooks = books.filter(book => book !== null && book.data).map(book => {
            if (!book.data.abstract) {
                return book;
            }

            const author = book.data.abstract
            .split('/')[0]
            .replace(/^[\[\(\{（【].*?[\]\)\}）】]/g, '')
            .replace(/\s+(著|编|译|等)/g, '')
            .trim()

            return {
                ...book,
                author: author,
            };
        });
        if (JSON.stringify(filteredBooks) == JSON.stringify(existingBooks)) {
            console.log('No changes to book information. No file write necessary.');
            return;
        }

        fs.writeFileSync(OUTPUT_FILE, `export const books = ${JSON.stringify(filteredBooks, null, 2)};`);
        console.log('Book information successfully written to', OUTPUT_FILE);
    } catch (error) {
        console.error('Error processing book information:', error);
    }
}

fetchBooksInfo();
