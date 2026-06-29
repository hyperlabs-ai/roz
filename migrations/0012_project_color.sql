-- 0012 — Color de identidad por proyecto (opcional). Permite asignar manualmente el color de marca
-- interno de cada proyecto; el dashboard lo usa para el monograma/identidad visual. Si es null, el
-- front cae a un color determinístico derivado de la key. Formato libre (se espera hex "#RRGGBB").
alter table roz.project add column if not exists color text;
