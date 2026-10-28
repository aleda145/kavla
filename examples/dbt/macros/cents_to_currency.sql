{% macro cents_to_currency(column_name) %}
    round(cast({{ column_name }} as decimal(18, 2)) / 100, 2)
{% endmacro %}
