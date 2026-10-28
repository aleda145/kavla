select
    order_id,
    customer_id,
    cast(order_date as date) as order_date,
    {{ cents_to_currency('amount_cents') }} as amount,
    status
from {{ ref('orders') }}
