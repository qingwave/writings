const fs = require('fs');
const matter = require('gray-matter');
const slugify = require('limax');

const args = process.argv.slice(2);
const slug = args[0];

if (!slug) {
  console.log(`post name is empty, there is an example:\n  npm run new "some blog"`);
  process.exit(1);
}

const templateName = 'post.md';

const templateFile = fs.readFileSync(`scripts/templates/${templateName}`);
const { content, data: frontmatter } = matter(templateFile);
frontmatter.title = slug;
frontmatter.date = new Date();

const name = slugify(slug, {
  tone: false,
});

const file = `./src/content/post/${name}.md`;

console.log('create new file %s, matter: %s', file, frontmatter);

try {
  fs.writeFileSync(file, matter.stringify(content, frontmatter));
} catch (err) {
  console.log('write file failed: ', err);
  process.exit(1);
}

console.log(`write file success, see ${file}`);
