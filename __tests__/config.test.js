import { loadSiteConfig } from '../dist/index.js';

describe('Environment Variable Configuration', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...OLD_ENV };
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    test('parses semicolon-delimited values with escapes', async () => {
        process.env.WP_NAME = 'site1;site\\;3';
        process.env.WP_URL_OVERRIDE = 'https://site1.com;https://site3.com';
        process.env.WP_USER_OVERRIDE = 'user1;user3';
        process.env.WP_PASS_OVERRIDE = 'pass1;pass\\;word';

        const config = await loadSiteConfig();
        
        expect(config).toEqual({
            'site1': {
                url: 'https://site1.com',
                username: 'user1',
                auth: 'pass1'
            },
            'site;3': {
                url: 'https://site3.com',
                username: 'user3',
                auth: 'pass;word'
            }
        });
    });

    test('throws error on mismatched counts', async () => {
        process.env.WP_NAME = 'site1;site2';
        process.env.WP_URL_OVERRIDE = 'https://site1.com';
        process.env.WP_USER_OVERRIDE = 'user1;user2';
        process.env.WP_PASS_OVERRIDE = 'pass1';

        await expect(loadSiteConfig())
            .rejects
            .toThrow('All environment variables must have matching number of values');
    });

    test('prefers environment variables over file config', async () => {
        process.env.WP_NAME = 'env_site';
        process.env.WP_URL_OVERRIDE = 'https://env.site';
        process.env.WP_USER_OVERRIDE = 'env_user';
        process.env.WP_PASS_OVERRIDE = 'env_pass';
        process.env.WP_SITES_PATH = './wp-sites-example.json';

        const config = await loadSiteConfig();
        expect(config).toHaveProperty('env_site');
        expect(config).not.toHaveProperty('example_site');
    });
});