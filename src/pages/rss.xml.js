import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { postPath, visiblePosts } from '../lib/posts';

export async function GET(context) {
  const posts = visiblePosts(await getCollection('blog'));
  return rss({
    title: 'TweakLab',
    description: '개발하면서 정리한 내용을 기록하는 기술 블로그',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.publishedAt,
      link: postPath(post),
      categories: post.data.tags,
    })),
  });
}
