-- Spanish joins French and English.
alter table tribune.site drop constraint if exists site_default_locale_check;
alter table tribune.site add constraint site_default_locale_check check (default_locale in ('fr','en','es'));
alter table tribune.app_user drop constraint if exists app_user_locale_check;
alter table tribune.app_user add constraint app_user_locale_check check (locale in ('fr','en','es'));
